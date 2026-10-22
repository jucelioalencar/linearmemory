import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterSearchResults, filterSettingsSchema, type FilterSettings } from '../src/search-filter.js';

const settings: FilterSettings = { enabled: true, provider: 'openai', thresholdPercent: 70, timeoutMs: 1000, model: 'gpt-6-luna', apiKey: 'test-secret' };
const candidates = [{ id: 'a', title: 'Relevant', summary: 'Useful fact', content: 'Long memory '.repeat(100), lexical_relevance: 0.9 }, { id: 'b', title: 'Noise', summary: 'Other fact', semantic_relevance: 0.8 }];
function mock(handler: (body: any, init: RequestInit) => unknown): typeof fetch {
  return (async (_url: unknown, init: RequestInit) => new Response(JSON.stringify(handler(JSON.parse(init.body as string), init)), { status: 200 })) as typeof fetch;
}
test('OpenAI filters both retrieval sources, preserves ordering, and records usage and evidence', async () => {
  const result = await filterSearchResults('Useful', candidates, settings, mock((body, init) => {
    assert.equal(init.headers && (init.headers as any).authorization, 'Bearer test-secret');
    assert.equal(body.questions[0].type, 'predicate');
    assert.equal(body.questions[0].name, 'relevant');
    const memory = JSON.parse(body.input).memory;
    return { answers: [{ name: 'relevant', type: 'predicate', probability: memory.title === 'Relevant' ? 0.7 : 0.2 }], usage: { input_tokens: 20, output_tokens: 0 } };
  }));
  assert.deepEqual(result.results.map(x => x.id), ['a']);
  assert.equal(result.audit.decisions[1].reason, 'below_threshold');
  assert.equal(result.audit.tokens.providerInput, 40);
  assert.ok(result.audit.tokens.saved > 0);
  assert.equal(result.audit.tokens.netEstimated, result.audit.tokens.saved - 40);
});
test('Jev uses named noul questions and supports eliminating all candidates', async () => {
  const result = await filterSearchResults('x', candidates, { ...settings, provider: 'jev', model: 'jev-latest' }, mock(body => {
    assert.ok(body.state); assert.equal(body.questions.relevant.type, 'noul');
    return { answers: { relevant: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 50, output_tokens: 2 } };
  }));
  assert.deepEqual(result.results, []);
  assert.equal(result.audit.tokens.providerOutput, 4);
});
test('disabled and missing credentials never call the provider', async () => {
  for (const config of [{ ...settings, enabled: false }, { ...settings, apiKey: '' }]) {
    const result = await filterSearchResults('x', candidates, config, mock(() => assert.fail('unexpected request')));
    assert.deepEqual(result.results, candidates); assert.equal(result.audit.tokens.saved, 0);
  }
});
test('refusal, malformed probabilities, wrong names and duplicate answers fail open', async () => {
  for (const answers of [[{ name: 'relevant', type: 'refusal' }], [{ name: 'relevant', type: 'predicate', probability: '0.8' }], [{ name: 'wrong', type: 'predicate', probability: 0 }], [{ name: 'relevant', type: 'predicate', probability: 2 }], [{ name: 'relevant', type: 'predicate', probability: 0 }, { name: 'relevant', type: 'predicate', probability: 0 }]]) {
    const result = await filterSearchResults('x', candidates, settings, mock(() => ({ answers })));
    assert.deepEqual(result.results, candidates); assert.equal(result.audit.decisions[0].reason, 'invalid_answer');
    assert.equal(result.audit.tokens.netEstimated, null);
  }
});
test('timeouts and HTTP failures keep memories without leaking errors or credentials', async () => {
  const http = (async () => new Response('secret-provider-body', { status: 429 })) as typeof fetch;
  const result = await filterSearchResults('x', candidates, settings, http);
  assert.equal(result.audit.decisions[0].reason, 'http_429');
  assert.ok(!JSON.stringify(result).includes('secret'));
  const timeout = (async (_url: unknown, init: RequestInit) => { return await new Promise<Response>((_, reject) => { init.signal!.addEventListener('abort', () => reject(Error('aborted')), { once: true }); }); }) as typeof fetch;
  const keepAlive = setInterval(() => {}, 100);
  try {
    const expired = await filterSearchResults('x', candidates, { ...settings, timeoutMs: 20 }, timeout);
    assert.deepEqual(expired.results, candidates); assert.equal(expired.audit.decisions[0].reason, 'timeout');
  } finally { clearInterval(keepAlive); }
});
test('empty and oversized inputs are safe; settings reject invalid percentages', async () => {
  const empty = await filterSearchResults('x', [], settings, mock(() => assert.fail()));
  assert.equal(empty.audit.tokens.saved, 0);
  const large = await filterSearchResults('x', [{ ...candidates[0], content: 'a'.repeat(24001) }], settings, mock(() => assert.fail()));
  assert.equal(large.audit.decisions[0].reason, 'context_limit');
  for (const thresholdPercent of [-1, 101, NaN, '70']) assert.equal(filterSettingsSchema.safeParse({ ...settings, thresholdPercent }).success, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { eventTitleSchema, reflectionInputSchema } from '../src/tool-inputs.js';

test('event titles preserve the reported long Portuguese decision and Unicode', () => {
  const title = 'Inventário medido em origin/main: nenhum par de Deployments com a mesma imagem no parque; o segundo processo por repositório é o Job de migrations com imagem própria';
  assert.ok(title.length > 160);
  assert.equal(eventTitleSchema.parse(title), title);
  assert.equal(eventTitleSchema.parse('🧠'.repeat(200)), '🧠'.repeat(200));
  assert.equal(eventTitleSchema.safeParse(' ').success, false);
});

test('reflection accepts strings and lists without losing recommendations or metadata', () => {
  const input = {
    executionId: 'c42199ec-c3be-4851-a377-f60e16b00393',
    title: 'Atualizar diagrama', reflectionType: 'ProcessLearning',
    whatWorked: 'Ler as memórias antes de escrever.',
    whatFailed: ['Export cortado.'], assumptions: 'Limite não medido.',
    recommendation: 'Conferir a última linha do PNG.', confidence: 0.85
  };
  const result = reflectionInputSchema.parse(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(result.whatWorked, [input.whatWorked]);
  assert.deepEqual(result.whatFailed, input.whatFailed);
  assert.deepEqual(result.recommendation, [input.recommendation]);
  assert.deepEqual(result.lessonsLearned, []);
  assert.equal(result.title, input.title);
  assert.equal(result.reflectionType, input.reflectionType);
  assert.equal(reflectionInputSchema.safeParse({ ...input, whatWorked: 42 }).success, false);
  assert.throws(() => JSON.parse('{"whatWorked": Texto sem aspas}'), SyntaxError);
});

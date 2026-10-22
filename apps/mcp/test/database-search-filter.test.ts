import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool } from '../src/db.js';
import { registerSearchFilterRoutes, resolveFilterSettings } from '../src/search-filter.js';

test('search filter settings persist encrypted credentials and isolate providers', async () => {
  const previous = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = 'isolated-filter-test-encryption-key';
  const app = express(); app.use(express.json()); registerSearchFilterRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/settings/search-filter`;
  const put = (body: unknown) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const settings = { enabled: true, provider: 'openai', model: 'gpt-6-luna', thresholdPercent: 85, timeoutMs: 5000 };
    assert.equal((await put(settings)).status, 400);
    const response = await put({ ...settings, apiKey: 'private-test-key' });
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes('private-test-key'));
    const stored = await pool.query("SELECT value FROM memory.system_settings WHERE key='search_filter'");
    assert.ok(stored.rows[0].value.encryptedApiKey.startsWith('v1:'));
    assert.ok(!JSON.stringify(stored.rows).includes('private-test-key'));
    assert.equal((await resolveFilterSettings()).apiKey, 'private-test-key');
    assert.equal((await put({ ...settings, thresholdPercent: 90 })).status, 200);
    const publicState = await (await fetch(url)).json();
    assert.equal(publicState.hasCredential, true); assert.equal(publicState.thresholdPercent, 90);
    assert.equal(publicState.apiKey, undefined); assert.equal(publicState.encryptedApiKey, undefined);
    assert.equal((await put({ ...settings, provider: 'jev', model: 'jev-latest' })).status, 400);
    assert.equal((await put({ ...settings, enabled: false, clearCredential: true })).status, 200);
    assert.equal((await resolveFilterSettings()).apiKey, '');
    assert.equal((await put({ ...settings, thresholdPercent: 101 })).status, 400);
  } finally {
    await pool.query("DELETE FROM memory.system_settings WHERE key='search_filter'");
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previous === undefined) delete process.env.CONFIG_ENCRYPTION_KEY; else process.env.CONFIG_ENCRYPTION_KEY = previous;
  }
});

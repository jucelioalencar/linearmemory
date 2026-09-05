import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createDatabaseBackup, restoreDatabaseBackup, serializeImportValue } from '../src/backup.js';
import { pool } from '../src/db.js';
import { createEmbedding, saveEmbeddingSettings } from '../src/embeddings.js';

test('JSON and JSONB backup values are serialized before PostgreSQL import', () => {
  const memoryChanges = [
    { nodeType: 'entity', changeType: 'Created' },
    { nodeType: 'procedure', changeType: 'Updated' }
  ];

  assert.equal(serializeImportValue(memoryChanges, 'jsonb'), JSON.stringify(memoryChanges));
  assert.equal(serializeImportValue({ enabled: false }, 'json'), '{"enabled":false}');
  assert.deepEqual(serializeImportValue(memoryChanges, 'text[]'), memoryChanges);
  assert.equal(serializeImportValue(null, 'jsonb'), null);
});

test('backup and restore replace the database atomically', {
  skip: process.env.ALLOW_DATABASE_RESTORE_TESTS !== '1'
}, async () => {
  const provider = createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }] }));
  });
  try {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    assert.ok(address && typeof address === 'object');
    await saveEmbeddingSettings({
      enabled: true,
      provider: 'openai-compatible',
      endpoint: `http://127.0.0.1:${address.port}/embeddings`,
      model: 'integration-embedding-model'
    });
    const embedding = await createEmbedding('semantic integration test');
    assert.equal(embedding?.length, 1536);

    const before = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM memory.workspaces');
    const backup = await createDatabaseBackup();
    const suffix = randomUUID().slice(0, 8);
    const domain = await pool.query<{ id: string }>(
      `INSERT INTO memory.knowledge_domains (domain_key,name,description)
       VALUES ($1,'Backup test','Temporary domain for restore verification.') RETURNING id`,
      [`backup-test-${suffix}`]
    );
    await pool.query(
      `INSERT INTO memory.workspaces (domain_id,workspace_key,display_name,description)
       VALUES ($1,$2,'Backup test workspace','Temporary workspace for restore verification.')`,
      [domain.rows[0].id, `backup-workspace-${suffix}`]
    );
    const changed = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM memory.workspaces');
    assert.equal(Number(changed.rows[0].count), Number(before.rows[0].count) + 1);

    const restored = await restoreDatabaseBackup(backup);
    assert.ok(restored.rows >= 0);
    const after = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM memory.workspaces');
    assert.equal(after.rows[0].count, before.rows[0].count);
  } finally {
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await pool.end();
  }
});

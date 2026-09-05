import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createDomain, createWorkspace } from '../src/catalog.js';
import { ensureAgent, pool } from '../src/db.js';
import { enqueueEmbeddingJob, processEmbeddingJob, saveEmbeddingSettings } from '../src/embeddings.js';
import { createOrReuseSession } from '../src/sessions.js';

test('PostgreSQL queue processes embeddings asynchronously with retries and no duplicate claims', async () => {
  let requests = 0;
  let failNext = false;
  const provider = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.setHeader('content-type', 'application/json');
    if (failNext) {
      failNext = false;
      response.statusCode = 503;
      response.end('{"error":"temporary failure"}');
      return;
    }
    response.end(JSON.stringify({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.02) }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address === 'object');

  const originalSettings = await pool.query<{ value: unknown }>(
    `SELECT value FROM memory.system_settings WHERE key='embeddings'`
  );
  const suffix = randomUUID().slice(0, 8);
  const setupClient = await pool.connect();
  let domainId = '';
  let workspaceId = '';
  let sessionId = '';
  let agentId = '';
  try {
    const domain = await createDomain(setupClient, {
      domainKey: `embedding-queue-${suffix}`,
      name: 'Embedding queue test',
      description: 'Temporary domain for PostgreSQL embedding queue validation.',
      tags: ['testcontainers'], metadata: {}
    });
    domainId = domain.id;
    const workspace = await createWorkspace(setupClient, {
      domainId,
      workspaceKey: `embedding-queue-${suffix}`,
      name: 'Embedding queue test',
      description: 'Temporary workspace for embedding jobs.',
      tags: ['testcontainers'], creationReason: 'Validate the durable embedding queue.', metadata: {}
    });
    workspaceId = workspace.id;
    agentId = await ensureAgent(`embedding-queue-${suffix}`);
    sessionId = await createOrReuseSession(setupClient, {
      workspaceId, agentId, task: 'Embedding queue integration test', metadata: {}
    });
    await saveEmbeddingSettings({
      enabled: true,
      provider: 'openai-compatible',
      endpoint: `http://127.0.0.1:${address.port}/embeddings`,
      model: 'queue-integration-model'
    });

    const createMemory = async (title: string) => {
      const result = await setupClient.query<{ id: string }>(
        `INSERT INTO memory.memory_nodes
           (workspace_id,source_session_id,node_type,title,summary,content_hash)
         VALUES ($1,$2,'fact',$3,'Queue integration memory.',$4) RETURNING id`,
        [workspaceId, sessionId, title, `${suffix}-${title}`]
      );
      await enqueueEmbeddingJob(setupClient, result.rows[0].id, 100);
      return result.rows[0].id;
    };

    const firstMemory = await createMemory('Asynchronous completion');
    assert.equal(requests, 0, 'enqueueing must not call the embedding provider');
    assert.equal(await processEmbeddingJob(), true);
    assert.equal(requests, 1);
    const completed = await pool.query<{ dimensions: number; status: string }>(
      `SELECT vector_dims(n.embedding)::int AS dimensions,j.status
         FROM memory.memory_nodes n JOIN memory.embedding_jobs j ON j.memory_id=n.id
        WHERE n.id=$1`,
      [firstMemory]
    );
    assert.deepEqual(completed.rows[0], { dimensions: 1536, status: 'completed' });

    const retryMemory = await createMemory('Retry after provider failure');
    failNext = true;
    assert.equal(await processEmbeddingJob(), true);
    const retryPending = await pool.query<{ status: string; attempts: number; last_error: string }>(
      `SELECT status,attempts,last_error FROM memory.embedding_jobs WHERE memory_id=$1`, [retryMemory]
    );
    assert.equal(retryPending.rows[0].status, 'pending');
    assert.equal(retryPending.rows[0].attempts, 1);
    assert.match(retryPending.rows[0].last_error, /did not return a vector/);
    await pool.query(`UPDATE memory.embedding_jobs SET available_at=now() WHERE memory_id=$1`, [retryMemory]);
    assert.equal(await processEmbeddingJob(), true);

    const concurrentA = await createMemory('Concurrent worker A');
    const concurrentB = await createMemory('Concurrent worker B');
    await Promise.all([processEmbeddingJob(), processEmbeddingJob()]);
    const concurrent = await pool.query<{ memory_id: string; status: string }>(
      `SELECT memory_id,status FROM memory.embedding_jobs WHERE memory_id=ANY($1::uuid[]) ORDER BY memory_id`,
      [[concurrentA, concurrentB]]
    );
    assert.equal(concurrent.rows.length, 2);
    assert.ok(concurrent.rows.every(row => row.status === 'completed'));
  } finally {
    setupClient.release();
    if (workspaceId) {
      await pool.query('DELETE FROM memory.memory_nodes WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM memory.sessions WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM memory.workspaces WHERE id=$1', [workspaceId]);
    }
    if (domainId) await pool.query('DELETE FROM memory.knowledge_domains WHERE id=$1', [domainId]);
    if (agentId) await pool.query('DELETE FROM memory.agents WHERE id=$1', [agentId]);
    await pool.query(
      `UPDATE memory.system_settings SET value=$1::jsonb,updated_at=now() WHERE key='embeddings'`,
      [JSON.stringify(originalSettings.rows[0]?.value ?? { enabled: false })]
    );
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});

test.after(async () => pool.end());

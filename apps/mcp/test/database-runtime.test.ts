import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDomain, createWorkspace } from '../src/catalog.js';
import { ensureAgent, pool } from '../src/db.js';
import { addProtocolEvent } from '../src/events.js';
import { createOrReuseSession } from '../src/sessions.js';

test('production PostgreSQL extensions, migrations, and search indexes are available', async () => {
  const extensions = await pool.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname IN ('graph','vector','pg_cron','pg_trgm','unaccent')`
  );
  assert.deepEqual(extensions.rows.map(row => row.extname).sort(), ['graph', 'pg_cron', 'pg_trgm', 'unaccent', 'vector']);
  const migrations = await pool.query<{ name: string }>('SELECT name FROM memory.schema_migrations ORDER BY name');
  assert.ok(migrations.rows.some(row => row.name === '003-search-performance.sql'));
  const index = await pool.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname='memory' AND indexname='memory_nodes_title_similarity_idx'`
  );
  assert.equal(index.rowCount, 1);
});

test('missing agent identity consistently resolves to agent_default', async () => {
  const first = await ensureAgent();
  const reused = await ensureAgent('   ');
  assert.equal(reused, first);
  const stored = await pool.query<{ agent_key: string }>('SELECT agent_key FROM memory.agents WHERE id=$1', [first]);
  assert.equal(stored.rows[0].agent_key, 'agent_default');
});

test('concurrent protocol events receive a gapless unique execution sequence', async () => {
  const suffix = randomUUID().slice(0, 8);
  const setupClient = await pool.connect();
  const domain = await createDomain(setupClient, {
      domainKey: `events-${suffix}`,
      name: 'Concurrent events',
      description: 'Isolated Testcontainers domain for concurrent event validation.',
      tags: ['testcontainers'], metadata: {}
    });
  const workspace = await createWorkspace(setupClient, {
      domainId: domain.id,
      workspaceKey: `events-${suffix}`,
      name: 'Concurrent events',
      description: 'Isolated workspace for concurrent event validation.',
      tags: ['testcontainers'], creationReason: 'Required for integration coverage.', metadata: {}
    });
  const agent = await setupClient.query<{ id: string }>(
      `INSERT INTO memory.agents (agent_key) VALUES ($1) RETURNING id`, [`events-${suffix}`]
    );
  const sessionId = await createOrReuseSession(setupClient, {
      workspaceId: workspace.id, agentId: agent.rows[0].id, task: 'Concurrent event test', metadata: {}
    });
  const execution = await setupClient.query<{ id: string }>(
      `INSERT INTO memory.executions
         (domain_id,workspace_id,session_id,agent_id,goal,user_request,language,environment)
       VALUES ($1,$2,$3,$4,'Concurrency','Concurrency','en-US','testcontainers') RETURNING id`,
      [domain.id, workspace.id, sessionId, agent.rows[0].id]
    );
  setupClient.release();

  try {
    await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await addProtocolEvent(client, execution.rows[0].id, 'ProgressUpdated', `Event ${index}`, 'Concurrent test event.', 'System');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }));
    const sequences = await pool.query<{ sequence: number }>(
      'SELECT sequence FROM memory.execution_events WHERE execution_id=$1 ORDER BY sequence', [execution.rows[0].id]
    );
    assert.deepEqual(sequences.rows.map(row => row.sequence), Array.from({ length: 20 }, (_, index) => index + 1));
  } finally {
    await pool.query('DELETE FROM memory.execution_events WHERE execution_id=$1', [execution.rows[0].id]);
    await pool.query('DELETE FROM memory.executions WHERE id=$1', [execution.rows[0].id]);
    await pool.query('DELETE FROM memory.sessions WHERE id=$1', [sessionId]);
    await pool.query('DELETE FROM memory.workspaces WHERE id=$1', [workspace.id]);
    await pool.query('DELETE FROM memory.knowledge_domains WHERE id=$1', [domain.id]);
    await pool.query('DELETE FROM memory.agents WHERE id=$1', [agent.rows[0].id]);
  }
});

test.after(async () => pool.end());

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDomain, createWorkspace } from '../src/catalog.js';
import { pool } from '../src/db.js';
import { createOrReuseSession, finishSessionIfIdle } from '../src/sessions.js';

test('creation is immutable and caller session ids are safely reusable', async () => {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    const suffix = randomUUID().slice(0, 8);
    const domain = await createDomain(client, {
      domainKey: `integration-${suffix}`,
      name: 'Integration domain',
      description: 'Temporary domain used by the database integration test.',
      tags: ['test'],
      metadata: {}
    });
    await assert.rejects(
      createDomain(client, {
        domainKey: domain.domain_key,
        name: 'Mutated name',
        description: 'This duplicate must never overwrite the original domain.',
        tags: [],
        metadata: {}
      }),
      /already exists/
    );
    const unchanged = await client.query('SELECT name FROM memory.knowledge_domains WHERE id=$1', [domain.id]);
    assert.equal(unchanged.rows[0].name, 'Integration domain');

    const firstWorkspace = await createWorkspace(client, {
      domainId: domain.id,
      workspaceKey: `workspace-a-${suffix}`,
      name: 'Workspace A',
      description: 'First workspace used to validate session ownership.',
      tags: [],
      creationReason: 'Required by the integration test.',
      metadata: {}
    });
    const secondWorkspace = await createWorkspace(client, {
      domainId: domain.id,
      workspaceKey: `workspace-b-${suffix}`,
      name: 'Workspace B',
      description: 'Second workspace used to validate session ownership.',
      tags: [],
      creationReason: 'Required by the integration test.',
      metadata: {}
    });
    const agent = await client.query<{ id: string }>(
      `INSERT INTO memory.agents (agent_key) VALUES ($1) RETURNING id`,
      [`integration-agent-${suffix}`]
    );
    const sessionId = randomUUID();
    const first = await createOrReuseSession(client, {
      sessionId,
      workspaceId: firstWorkspace.id,
      agentId: agent.rows[0].id,
      task: 'first execution',
      metadata: {}
    });
    const reused = await createOrReuseSession(client, {
      sessionId,
      workspaceId: firstWorkspace.id,
      agentId: agent.rows[0].id,
      task: 'second execution',
      metadata: {}
    });
    assert.equal(reused, first);
    await assert.rejects(
      createOrReuseSession(client, {
        sessionId,
        workspaceId: secondWorkspace.id,
        agentId: agent.rows[0].id,
        task: 'invalid reuse',
        metadata: {}
      }),
      /another workspace or agent/
    );

    const executions = await client.query<{ id: string }>(
      `INSERT INTO memory.executions
         (domain_id,workspace_id,session_id,agent_id,goal,user_request,language,environment)
       VALUES ($1,$2,$3,$4,'first','first','en-US','test'),
              ($1,$2,$3,$4,'second','second','en-US','test') RETURNING id`,
      [domain.id, firstWorkspace.id, sessionId, agent.rows[0].id]
    );
    await client.query(`UPDATE memory.executions SET status='completed',completed_at=now() WHERE id=$1`, [executions.rows[0].id]);
    assert.equal(await finishSessionIfIdle(client, sessionId), false);
    const stillActive = await client.query('SELECT status FROM memory.sessions WHERE id=$1', [sessionId]);
    assert.equal(stillActive.rows[0].status, 'active');
    await client.query(`UPDATE memory.executions SET status='completed',completed_at=now() WHERE id=$1`, [executions.rows[1].id]);
    assert.equal(await finishSessionIfIdle(client, sessionId), true);
    const completed = await client.query('SELECT status FROM memory.sessions WHERE id=$1', [sessionId]);
    assert.equal(completed.rows[0].status, 'completed');

    const nodes = await client.query<{ id: string }>(
      `INSERT INTO memory.memory_nodes
         (workspace_id,source_session_id,node_type,title,summary,content_hash)
       VALUES ($1,$2,'fact','First assertion','Temporary integration assertion.',$3),
              ($1,$2,'fact','Contradicting assertion','Temporary contradictory assertion.',$4)
       RETURNING id`,
      [firstWorkspace.id, sessionId, `first-${suffix}`, `second-${suffix}`]
    );
    const relation = await client.query<{ id: string }>(
      `INSERT INTO memory.memory_relations
         (workspace_id,source_id,target_id,relation_type,metadata)
       VALUES ($1,$2,$3,'contradicts','{"explanation":"Integration conflict lifecycle."}')
       RETURNING id`,
      [firstWorkspace.id, nodes.rows[0].id, nodes.rows[1].id]
    );
    const openedConflict = await client.query(
      `SELECT status FROM memory.memory_conflicts
        WHERE workspace_id=$1
          AND memory_a_id=LEAST($2::uuid,$3::uuid)
          AND memory_b_id=GREATEST($2::uuid,$3::uuid)`,
      [firstWorkspace.id, nodes.rows[0].id, nodes.rows[1].id]
    );
    assert.equal(openedConflict.rows[0]?.status, 'open');
    await client.query('DELETE FROM memory.memory_relations WHERE id=$1', [relation.rows[0].id]);
    const dismissedConflict = await client.query(
      `SELECT status FROM memory.memory_conflicts
        WHERE workspace_id=$1
          AND memory_a_id=LEAST($2::uuid,$3::uuid)
          AND memory_b_id=GREATEST($2::uuid,$3::uuid)`,
      [firstWorkspace.id, nodes.rows[0].id, nodes.rows[1].id]
    );
    assert.equal(dismissedConflict.rows[0]?.status, 'dismissed');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});

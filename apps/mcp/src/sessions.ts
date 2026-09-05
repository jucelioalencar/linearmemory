import type pg from 'pg';

export async function createOrReuseSession(
  client: pg.PoolClient,
  input: { sessionId?: string; workspaceId: string; agentId: string; task: string; metadata: Record<string, unknown> }
): Promise<string> {
  const session = await client.query<{ id: string }>(
    `INSERT INTO memory.sessions (id,workspace_id,agent_id,task,metadata)
     VALUES (COALESCE($1::uuid,gen_random_uuid()),$2,$3,$4,$5::jsonb)
     ON CONFLICT (id) DO UPDATE SET status='active',finished_at=NULL
       WHERE memory.sessions.workspace_id=EXCLUDED.workspace_id
         AND memory.sessions.agent_id IS NOT DISTINCT FROM EXCLUDED.agent_id
     RETURNING id`,
    [input.sessionId ?? null, input.workspaceId, input.agentId, input.task, JSON.stringify(input.metadata)]
  );
  if (!session.rows[0]) {
    throw new Error('sessionId belongs to another workspace or agent. Use the original context or start a new session.');
  }
  return session.rows[0].id;
}

export async function finishSessionIfIdle(client: pg.PoolClient, sessionId: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE memory.sessions s
        SET status=CASE
              WHEN EXISTS (SELECT 1 FROM memory.executions x WHERE x.session_id=s.id AND x.status='failed') THEN 'failed'
              WHEN EXISTS (SELECT 1 FROM memory.executions x WHERE x.session_id=s.id AND x.status='cancelled') THEN 'cancelled'
              ELSE 'completed' END,
            finished_at=now()
      WHERE s.id=$1
        AND NOT EXISTS (SELECT 1 FROM memory.executions x WHERE x.session_id=s.id AND x.status='active')
    RETURNING id`,
    [sessionId]
  );
  return result.rowCount === 1;
}

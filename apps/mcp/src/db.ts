import pg from 'pg';
import { readFile } from 'node:fs/promises';

const { Pool } = pg;

const passwordFile = process.env.PGPASSWORD_FILE?.trim();
export const pool = new Pool({
  max: 10,
  ...(passwordFile ? { password: async () => (await readFile(passwordFile, 'utf8')).trim() } : {})
});

export async function ensureAgent(agentKey?: string): Promise<string> {
  const resolvedAgentKey = agentKey?.trim() || 'agent_default';
  const result = await pool.query<{ id: string }>(
    `INSERT INTO memory.agents (agent_key)
     VALUES ($1)
     ON CONFLICT (agent_key) DO UPDATE SET agent_key = EXCLUDED.agent_key
     RETURNING id`,
    [resolvedAgentKey]
  );
  return result.rows[0].id;
}

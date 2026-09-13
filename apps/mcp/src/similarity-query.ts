import { pool } from './db.js';

// The pg_trgm threshold belongs to this transaction, never to a pooled session.
export async function similarityQuery(sql: string, values: unknown[], threshold: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('pg_trgm.similarity_threshold',$1,true)", [String(Math.max(0, threshold - 0.000001))]);
    const result = await client.query(sql, values);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

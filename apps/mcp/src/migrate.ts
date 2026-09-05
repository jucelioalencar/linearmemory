import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const migrationDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS memory`);
    await client.query(`CREATE TABLE IF NOT EXISTS memory.schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(`SELECT pg_advisory_lock(hashtext('linearmemory-schema-migrations'))`);
    const files = (await readdir(migrationDirectory)).filter(file => file.endsWith('.sql')).sort();
    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM memory.schema_migrations WHERE name=$1', [file]);
      if (applied.rows[0]) continue;
      const sql = await readFile(`${migrationDirectory}/${file}`, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO memory.schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.error(`Applied migration ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('linearmemory-schema-migrations'))`).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('Database migration failed.', error);
  process.exitCode = 1;
});

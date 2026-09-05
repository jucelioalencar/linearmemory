import type { Express, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from './db.js';

const BACKUP_FORMAT = 'linearmemory-backup';
const BACKUP_VERSION = 1;
const tables = [
  'knowledge_domains',
  'workspaces',
  'agents',
  'sessions',
  'memory_events',
  'executions',
  'execution_events',
  'reflections',
  'memory_nodes',
  'memory_relations',
  'memory_conflicts',
  'system_settings'
] as const;

type TableName = typeof tables[number];
type TableBackup = { columns: string[]; rows: Array<Record<string, unknown>> };
type DatabaseBackup = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  tables: Record<TableName, TableBackup>;
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function exportTable(client: PoolClient, table: TableName): Promise<TableBackup> {
  const columns = await client.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='memory' AND table_name=$1 AND is_generated='NEVER'
      ORDER BY ordinal_position`,
    [table]
  );
  const names = columns.rows.map(row => row.column_name);
  const selection = names.map(quoteIdentifier).join(',');
  const rows = await client.query<Record<string, unknown>>(
    `SELECT ${selection} FROM memory.${quoteIdentifier(table)}`
  );
  return { columns: names, rows: rows.rows };
}

export async function createDatabaseBackup(): Promise<DatabaseBackup> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const entries: Array<readonly [TableName, TableBackup]> = [];
    for (const table of tables) entries.push([table, await exportTable(client, table)] as const);
    await client.query('COMMIT');
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      tables: Object.fromEntries(entries) as Record<TableName, TableBackup>
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function validateBackup(value: unknown): asserts value is DatabaseBackup {
  if (!value || typeof value !== 'object') throw new Error('The selected file is not a LinearMemory backup.');
  const backup = value as Partial<DatabaseBackup>;
  if (backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION || !backup.tables) {
    throw new Error('Unsupported LinearMemory backup format or version.');
  }
  for (const table of tables) {
    const data = backup.tables[table];
    if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
      throw new Error(`Backup table ${table} is missing or invalid.`);
    }
    if (data.columns.some(column => typeof column !== 'string')) throw new Error(`Backup table ${table} has invalid columns.`);
  }
}

async function importTable(client: PoolClient, table: TableName, data: TableBackup): Promise<void> {
  if (!data.rows.length) return;
  const currentColumns = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='memory' AND table_name=$1 AND is_generated='NEVER'`,
    [table]
  );
  const allowed = new Set(currentColumns.rows.map(row => row.column_name));
  if (data.columns.some(column => !allowed.has(column))) throw new Error(`Backup table ${table} contains unknown columns.`);
  const columns = data.columns.map(quoteIdentifier).join(',');
  const placeholders = data.columns.map((_, index) => `$${index + 1}`).join(',');
  const identityOverride = table === 'memory_events' ? ' OVERRIDING SYSTEM VALUE' : '';
  const sql = `INSERT INTO memory.${quoteIdentifier(table)} (${columns})${identityOverride} VALUES (${placeholders})`;
  for (const row of data.rows) {
    await client.query(sql, data.columns.map(column => row[column]));
  }
}

export async function restoreDatabaseBackup(value: unknown): Promise<{ restoredAt: string; rows: number }> {
  validateBackup(value);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('linearmemory-database-restore'))`);
    await client.query(`TRUNCATE TABLE ${tables.map(table => `memory.${quoteIdentifier(table)}`).join(',')} RESTART IDENTITY CASCADE`);
    let rows = 0;
    for (const table of tables) {
      await importTable(client, table, value.tables[table]);
      rows += value.tables[table].rows.length;
    }
    await client.query(
      `SELECT setval(pg_get_serial_sequence('memory.memory_events','sequence'),
                     GREATEST(COALESCE((SELECT max(sequence) FROM memory.memory_events),0),1),
                     EXISTS (SELECT 1 FROM memory.memory_events))`
    );
    await client.query('COMMIT');
    await pool.query('SELECT * FROM graph.build()').catch(error => console.error('Graph rebuild after restore failed.', error));
    return { restoredAt: new Date().toISOString(), rows };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function registerBackupRoutes(app: Express): void {
  app.get('/api/settings/database/backup', async (_req: Request, res: Response) => {
    try {
      const backup = await createDatabaseBackup();
      const date = backup.createdAt.slice(0, 10);
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="linearmemory-backup-${date}.json"`);
      res.send(JSON.stringify(backup));
    } catch (error) {
      console.error('Database backup failed.', error);
      res.status(500).json({ error: 'Unable to create the database backup.' });
    }
  });
  app.post('/api/settings/database/restore', async (req: Request, res: Response) => {
    try {
      if (req.body?.confirmation !== 'RESTORE') {
        res.status(400).json({ error: 'Restore confirmation is required.' });
        return;
      }
      res.json(await restoreDatabaseBackup(req.body.backup));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to restore the database backup.';
      console.error('Database restore failed.', error);
      res.status(400).json({ error: message });
    }
  });
}

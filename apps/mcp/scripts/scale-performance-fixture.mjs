import pg from 'pg';

// Only run against an isolated snapshot, never the application database.
const pool = new pg.Pool();
const factor = Number(process.env.PERF_SCALE ?? 100);
const tables = ['sessions', 'executions', 'memory_events', 'execution_events', 'memory_nodes', 'memory_relations', 'memory_conflicts', 'reflections'];
const client = await pool.connect();
try {
  const { rows: [db] } = await client.query('SELECT current_database() AS name');
  const validationError = !db.name.endsWith('_perf') || process.env.PERF_ISOLATED !== 'yes'
    ? 'Requires an isolated *_perf database and PERF_ISOLATED=yes.'
    : !Number.isInteger(factor) || factor < 1 || factor > 100
      ? 'PERF_SCALE must be 1..100'
      : undefined;
  if (validationError) {
    console.error(validationError);
    process.exitCode = 1;
  } else {
  await client.query('BEGIN');
  await client.query('CREATE TABLE memory.performance_fixture_marker (factor integer NOT NULL)');
  await client.query('INSERT INTO memory.performance_fixture_marker VALUES ($1)', [factor]);
  await client.query("UPDATE memory.system_settings SET value='{}'::jsonb WHERE key='embeddings'");
  await client.query('TRUNCATE memory.embedding_jobs');
  await client.query('SET LOCAL session_replication_role=replica');
  await client.query('CREATE TEMP TABLE fixture_ids(id uuid PRIMARY KEY)');
  for (const table of tables) {
    await client.query(`CREATE TEMP TABLE seed_${table} AS SELECT * FROM memory.${table}`);
    await client.query(`INSERT INTO fixture_ids SELECT id FROM seed_${table} ON CONFLICT DO NOTHING`);
  }
  await client.query(`CREATE FUNCTION pg_temp.remap(value jsonb, replica integer) RETURNS jsonb LANGUAGE plpgsql AS $$
  DECLARE result jsonb;
  BEGIN
    CASE jsonb_typeof(value)
    WHEN 'object' THEN SELECT jsonb_object_agg(key,pg_temp.remap(v,replica)) INTO result FROM jsonb_each(value) AS e(key,v);
    WHEN 'array' THEN SELECT jsonb_agg(pg_temp.remap(v,replica) ORDER BY ord) INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS e(v,ord);
    WHEN 'string' THEN
      IF (value#>>'{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        IF EXISTS(SELECT 1 FROM fixture_ids WHERE id=(value#>>'{}')::uuid) THEN
          RETURN to_jsonb(overlay(overlay(md5((value#>>'{}') || ':' || replica) placing '4' from 13 for 1) placing 'a' from 17 for 1)::uuid::text);
        END IF;
      END IF;
      RETURN value;
    ELSE RETURN value;
    END CASE;
    RETURN COALESCE(result,value);
  END $$`);
  for (const table of tables) {
    const { rows: columns } = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='memory' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`, [table]);
    const names = columns.map(c => `"${c.column_name}"`).join(',');
    for (let replica = 1; replica < factor; replica++) {
      let extras = "'{}'::jsonb";
      if (table === 'sessions') extras = `jsonb_build_object('external_session_key',CASE WHEN s.external_session_key IS NULL THEN NULL ELSE s.external_session_key || ':perf:${replica}' END)`;
      if (table === 'memory_nodes') extras = `jsonb_build_object('content_hash',CASE WHEN s.content_hash IS NULL THEN NULL ELSE s.content_hash || ':perf:${replica}' END)`;
      if (table === 'memory_events') extras = `jsonb_build_object('sequence',s.sequence + ${replica}*(SELECT COALESCE(max(sequence),0)+1 FROM seed_memory_events),'idempotency_key',CASE WHEN s.idempotency_key IS NULL THEN NULL ELSE s.idempotency_key || ':perf:${replica}' END)`;
      await client.query(`INSERT INTO memory.${table} (${names}) OVERRIDING SYSTEM VALUE SELECT ${columns.map(c => `r."${c.column_name}"`).join(',')} FROM seed_${table} s CROSS JOIN LATERAL jsonb_populate_record(NULL::memory.${table},pg_temp.remap(to_jsonb(s),${replica}) || ${extras}) r`);
    }
    console.log(JSON.stringify({ table, rows: (await client.query(`SELECT count(*)::int AS n FROM memory.${table}`)).rows[0].n }));
  }
  await client.query("SELECT setval(pg_get_serial_sequence('memory.memory_events','sequence'),GREATEST(1,(SELECT max(sequence) FROM memory.memory_events)))");
  // Triggers were disabled only in this transaction; verify every replicated FK.
  const { rows: references } = await client.query(`SELECT t.relname AS child,a.attname AS child_column,p.relname AS parent,b.attname AS parent_column
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace
    JOIN pg_class p ON p.oid=c.confrelid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=c.conkey[1]
    JOIN pg_attribute b ON b.attrelid=p.oid AND b.attnum=c.confkey[1]
    WHERE c.contype='f' AND ns.nspname='memory'`);
  let referenceError;
  for(const ref of references) {
    const { rows: [check] }=await client.query(`SELECT count(*)::int n FROM memory."${ref.child}" c LEFT JOIN memory."${ref.parent}" p ON p."${ref.parent_column}"=c."${ref.child_column}" WHERE c."${ref.child_column}" IS NOT NULL AND p."${ref.parent_column}" IS NULL`);
    if (check.n) {
      referenceError = `Fixture has broken reference: ${ref.child}.${ref.child_column}`;
      break;
    }
  }
  if (referenceError) {
    await client.query('ROLLBACK');
    console.error(referenceError);
    process.exitCode = 1;
  } else {
    await client.query('COMMIT');
    await client.query('ANALYZE');
  }
  }
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Unable to create the performance fixture.', error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}

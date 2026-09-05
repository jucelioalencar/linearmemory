import type pg from 'pg';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export async function createDomain(
  db: Queryable,
  input: { domainKey: string; name: string; description: string; tags: string[]; metadata: Record<string, unknown> }
) {
  const result = await db.query(
    `INSERT INTO memory.knowledge_domains (domain_key,name,description,tags,metadata)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (domain_key) DO NOTHING
     RETURNING id,domain_key,name,description,tags,metadata,created_at`,
    [input.domainKey, input.name, input.description, input.tags, JSON.stringify(input.metadata)]
  );
  if (!result.rows[0]) {
    const existing = await db.query('SELECT id FROM memory.knowledge_domains WHERE domain_key=$1', [input.domainKey]);
    throw new Error(`Domain "${input.domainKey}" already exists (id ${existing.rows[0]?.id ?? 'unknown'}). Reuse it instead of creating it.`);
  }
  return result.rows[0];
}

export async function createWorkspace(
  db: Queryable,
  input: { domainId: string; workspaceKey: string; name: string; description: string; tags: string[]; creationReason: string; metadata: Record<string, unknown> }
) {
  const result = await db.query(
    `INSERT INTO memory.workspaces (domain_id,workspace_key,display_name,description,tags,metadata)
     SELECT id,$2,$3,$4,$5,$6::jsonb || jsonb_build_object('creationReason',$7::text)
       FROM memory.knowledge_domains WHERE id=$1
     ON CONFLICT (workspace_key) DO NOTHING
     RETURNING id,domain_id,workspace_key,display_name,description,tags,metadata,created_at`,
    [input.domainId, input.workspaceKey, input.name, input.description, input.tags, JSON.stringify(input.metadata), input.creationReason]
  );
  if (!result.rows[0]) {
    const domain = await db.query('SELECT 1 FROM memory.knowledge_domains WHERE id=$1', [input.domainId]);
    if (!domain.rows[0]) throw new Error('Domain not found. Call find_domain before creating a workspace.');
    const existing = await db.query('SELECT id,domain_id FROM memory.workspaces WHERE workspace_key=$1', [input.workspaceKey]);
    throw new Error(`Workspace "${input.workspaceKey}" already exists (id ${existing.rows[0]?.id ?? 'unknown'}, domain ${existing.rows[0]?.domain_id ?? 'unknown'}). Reuse it instead of creating it.`);
  }
  return result.rows[0];
}

export async function updateDomain(
  db: Queryable,
  input: { domainId: string; name?: string; description?: string; tags?: string[]; metadata?: Record<string, unknown>; reason: string }
) {
  const result = await db.query(
    `UPDATE memory.knowledge_domains SET
       name=COALESCE($2,name),description=COALESCE($3,description),tags=COALESCE($4,tags),
       metadata=metadata || $5::jsonb || jsonb_build_object('lastUpdateReason',$6::text,'lastUpdatedAt',now())
     WHERE id=$1 RETURNING id,domain_key,name,description,tags,metadata,created_at,updated_at`,
    [input.domainId, input.name ?? null, input.description ?? null, input.tags ?? null, JSON.stringify(input.metadata ?? {}), input.reason]
  );
  if (!result.rows[0]) throw new Error('Domain not found.');
  return result.rows[0];
}

export async function updateWorkspace(
  db: Queryable,
  input: { workspaceId: string; name?: string; description?: string; tags?: string[]; metadata?: Record<string, unknown>; reason: string }
) {
  const result = await db.query(
    `UPDATE memory.workspaces SET
       display_name=COALESCE($2,display_name),description=COALESCE($3,description),tags=COALESCE($4,tags),
       metadata=metadata || $5::jsonb || jsonb_build_object('lastUpdateReason',$6::text,'lastUpdatedAt',now())
     WHERE id=$1 RETURNING id,domain_id,workspace_key,display_name,description,tags,metadata,created_at,updated_at`,
    [input.workspaceId, input.name ?? null, input.description ?? null, input.tags ?? null, JSON.stringify(input.metadata ?? {}), input.reason]
  );
  if (!result.rows[0]) throw new Error('Workspace not found.');
  return result.rows[0];
}

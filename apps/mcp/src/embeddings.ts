import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Express, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from './db.js';

const EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_MODEL = 'text-embedding-3-small';
const OLLAMA_URL = process.env.OLLAMA_URL?.trim().replace(/\/$/, '') || 'http://ollama:11434';
const embeddedModels = [
  { id: 'qwen3-embedding:4b', downloadSize: '2.5 GB', recommendedRam: '16 GB', tier: 'recommended' },
  { id: 'qwen3-embedding:8b-q4_K_M', downloadSize: '4.7 GB', recommendedRam: '24 GB', tier: 'advanced' }
] as const;
const providers = [
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1/embeddings', model: DEFAULT_MODEL, credentialRequired: true },
  { id: 'azure-openai', name: 'Azure OpenAI', endpoint: '', model: DEFAULT_MODEL, credentialRequired: true },
  { id: 'ollama', name: 'Ollama', endpoint: `${OLLAMA_URL}/api/embed`, model: 'qwen3-embedding:4b', credentialRequired: false },
  { id: 'openai-compatible', name: 'OpenAI-compatible', endpoint: '', model: DEFAULT_MODEL, credentialRequired: false }
] as const;

type ProviderId = typeof providers[number]['id'];
type StoredEmbeddingSettings = {
  enabled?: boolean;
  provider?: ProviderId;
  endpoint?: string;
  model?: string;
  encryptedApiKey?: string;
};
type ResolvedEmbeddingSettings = {
  enabled: boolean;
  provider: ProviderId;
  endpoint: string;
  model: string;
  apiKey: string;
};
type EmbeddingState = {
  enabled: boolean;
  configured: boolean;
  provider: ProviderId;
  endpoint: string;
  model: string;
  dimensions: number;
  hasCredential: boolean;
  providers: ReadonlyArray<typeof providers[number]>;
  totalMemories: number;
  embeddedMemories: number;
  pendingMemories: number;
  backfillRunning: boolean;
  queue: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
};

let backfillRunning = false;
let workerRunning = false;
let workerTimer: NodeJS.Timeout | null = null;
let workerStopping = false;
const workerId = `embedding-worker-${process.pid}-${randomBytes(4).toString('hex')}`;
const workerPollMs = Math.max(250, Number.parseInt(process.env.EMBEDDING_WORKER_POLL_MS ?? '1000', 10));
const workerConcurrency = Math.max(1, Math.min(8, Number.parseInt(process.env.EMBEDDING_WORKER_CONCURRENCY ?? '1', 10)));
const staleJobMs = Math.max(30_000, Number.parseInt(process.env.EMBEDDING_JOB_STALE_MS ?? '300000', 10));
const embeddingCache = new Map<string, number[]>();
const embeddingCacheSize = Math.max(0, Number.parseInt(process.env.EMBEDDING_CACHE_SIZE ?? '256', 10));
let settingsCache: { value: ResolvedEmbeddingSettings; expiresAt: number } | null = null;
let localInstallState: { model: string; status: 'idle' | 'downloading' | 'ready' | 'error'; message?: string } = {
  model: '',
  status: 'idle'
};

function readEncryptionSecret(): string {
  if (process.env.CONFIG_ENCRYPTION_KEY?.trim()) return process.env.CONFIG_ENCRYPTION_KEY.trim();
  const path = process.env.CONFIG_ENCRYPTION_KEY_FILE?.trim();
  if (!path) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function encryptionKey(): Buffer {
  const secret = readEncryptionSecret();
  if (!secret) throw new Error('Configure CONFIG_ENCRYPTION_KEY or CONFIG_ENCRYPTION_KEY_FILE before saving credentials.');
  return createHash('sha256').update(secret).digest();
}

function encryptCredential(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptCredential(value?: string): string {
  if (!value) return '';
  try {
    const [version, encodedIv, encodedTag, encodedPayload] = value.split(':');
    if (version !== 'v1' || !encodedIv || !encodedTag || !encodedPayload) return '';
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(encodedIv, 'base64'));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encodedPayload, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function providerDefinition(provider: ProviderId) {
  return providers.find(item => item.id === provider) ?? providers[0];
}

function isProviderId(value: string): value is ProviderId {
  return providers.some(item => item.id === value);
}

async function readStoredSettings(): Promise<StoredEmbeddingSettings> {
  const result = await pool.query<{ value: StoredEmbeddingSettings }>(
    `SELECT value FROM memory.system_settings WHERE key='embeddings'`
  );
  return result.rows[0]?.value ?? {};
}

async function resolveSettings(): Promise<ResolvedEmbeddingSettings> {
  if (settingsCache && settingsCache.expiresAt > Date.now()) return settingsCache.value;
  const stored = await readStoredSettings();
  const provider = providers.some(item => item.id === stored.provider) ? stored.provider! : 'openai';
  const definition = providerDefinition(provider);
  const resolved = {
    enabled: stored.enabled === true,
    provider,
    endpoint: stored.endpoint?.trim() || process.env.EMBEDDING_ENDPOINT?.trim() || definition.endpoint,
    model: stored.model?.trim() || process.env.EMBEDDING_MODEL?.trim() || definition.model,
    apiKey: decryptCredential(stored.encryptedApiKey) || process.env.EMBEDDING_API_KEY?.trim() || ''
  };
  settingsCache = { value: resolved, expiresAt: Date.now() + 5_000 };
  return resolved;
}

export async function getEmbeddingState(): Promise<EmbeddingState> {
  const [settings, counts, queueCounts] = await Promise.all([
    resolveSettings(),
    pool.query<{ total: string; embedded: string }>(
      `SELECT count(*) FILTER (WHERE status='active')::text AS total,
              count(*) FILTER (WHERE status='active' AND embedding IS NOT NULL)::text AS embedded
         FROM memory.memory_nodes`
    ),
    pool.query<{ status: 'pending' | 'processing' | 'completed' | 'failed'; count: string }>(
      `SELECT status,count(*)::text AS count FROM memory.embedding_jobs GROUP BY status`
    )
  ]);
  const definition = providerDefinition(settings.provider);
  const totalMemories = Number(counts.rows[0]?.total ?? 0);
  const embeddedMemories = Number(counts.rows[0]?.embedded ?? 0);
  const hasCredential = settings.apiKey.length > 0;
  const queue = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const row of queueCounts.rows) queue[row.status] = Number(row.count);
  return {
    enabled: settings.enabled,
    configured: settings.endpoint.length > 0 && (!definition.credentialRequired || hasCredential),
    provider: settings.provider,
    endpoint: settings.endpoint,
    model: settings.model,
    dimensions: EMBEDDING_DIMENSIONS,
    hasCredential,
    providers,
    totalMemories,
    embeddedMemories,
    pendingMemories: Math.max(0, totalMemories - embeddedMemories),
    backfillRunning: backfillRunning || queue.pending > 0 || queue.processing > 0,
    queue
  };
}

export async function saveEmbeddingSettings(input: {
  enabled: boolean;
  provider: ProviderId;
  endpoint: string;
  model: string;
  apiKey?: string;
  clearCredential?: boolean;
}): Promise<EmbeddingState> {
  if (!isProviderId(input.provider)) throw new Error('Unsupported embedding provider.');
  if (!/^https?:\/\//i.test(input.endpoint)) throw new Error('Embedding endpoint must be an HTTP or HTTPS URL.');
  if (!input.model.trim()) throw new Error('Embedding model is required.');
  const current = await readStoredSettings();
  const encryptedApiKey = input.clearCredential
    ? undefined
    : input.apiKey?.trim()
      ? encryptCredential(input.apiKey.trim())
      : current.encryptedApiKey;
  const credential = decryptCredential(encryptedApiKey) || process.env.EMBEDDING_API_KEY?.trim() || '';
  if (input.enabled && providerDefinition(input.provider).credentialRequired && !credential) {
    throw new Error('This provider requires an API credential.');
  }
  const value: StoredEmbeddingSettings = {
    enabled: input.enabled,
    provider: input.provider,
    endpoint: input.endpoint.trim(),
    model: input.model.trim(),
    ...(encryptedApiKey ? { encryptedApiKey } : {})
  };
  await pool.query(
    `INSERT INTO memory.system_settings (key,value,updated_at)
     VALUES ('embeddings',$1::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
    [JSON.stringify(value)]
  );
  settingsCache = null;
  embeddingCache.clear();
  if (input.enabled) void enqueueMissingEmbeddingJobs().catch(error => console.error('Unable to enqueue missing embeddings.', error));
  return getEmbeddingState();
}

export async function createEmbedding(text: string): Promise<number[] | null> {
  const settings = await resolveSettings();
  const definition = providerDefinition(settings.provider);
  if (!settings.enabled || !settings.endpoint || (definition.credentialRequired && !settings.apiKey)) return null;
  const cacheKey = createHash('sha256').update(`${settings.provider}\0${settings.endpoint}\0${settings.model}\0${text}`).digest('base64url');
  const cached = embeddingCache.get(cacheKey);
  if (cached) {
    embeddingCache.delete(cacheKey);
    embeddingCache.set(cacheKey, cached);
    return cached;
  }
  try {
    const isOllama = settings.provider === 'ollama';
    const response = await fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(settings.apiKey
          ? settings.provider === 'azure-openai'
            ? { 'api-key': settings.apiKey }
            : { authorization: `Bearer ${settings.apiKey}` }
          : {})
      },
      body: JSON.stringify(settings.provider === 'azure-openai'
        ? { input: text, dimensions: EMBEDDING_DIMENSIONS }
        : { model: settings.model, input: text, dimensions: EMBEDDING_DIMENSIONS }),
      signal: AbortSignal.timeout(isOllama ? 120_000 : 30_000)
    });
    if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}.`);
    const payload = await response.json() as { data?: Array<{ embedding?: number[] }>; embeddings?: number[][] };
    const embedding = isOllama ? payload.embeddings?.[0] : payload.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS || embedding.some(value => !Number.isFinite(value))) {
      throw new Error(`Embedding provider must return exactly ${EMBEDDING_DIMENSIONS} finite values.`);
    }
    if (embeddingCacheSize > 0) {
      embeddingCache.set(cacheKey, embedding);
      while (embeddingCache.size > embeddingCacheSize) {
        const oldest = embeddingCache.keys().next().value;
        if (oldest === undefined) break;
        embeddingCache.delete(oldest);
      }
    }
    return embedding;
  } catch (error) {
    console.error('Embedding generation failed; lexical search remains active.', error);
    return null;
  }
}

export function vectorParameter(embedding: number[] | null): string | null {
  return embedding ? `[${embedding.join(',')}]` : null;
}

type EmbeddingJob = {
  id: string;
  memory_id: string;
  attempts: number;
  max_attempts: number;
  generation: number;
};

export async function enqueueEmbeddingJob(client: PoolClient, memoryId: string, priority = 0): Promise<void> {
  await client.query(
    `INSERT INTO memory.embedding_jobs (memory_id,priority)
     VALUES ($1,$2)
     ON CONFLICT (memory_id) DO UPDATE SET
       status='pending',priority=GREATEST(memory.embedding_jobs.priority,EXCLUDED.priority),
       attempts=0,generation=memory.embedding_jobs.generation+1,available_at=now(),
       locked_at=NULL,locked_by=NULL,completed_at=NULL,last_error=NULL,updated_at=now()`,
    [memoryId, priority]
  );
}

export async function enqueueMissingEmbeddingJobs(): Promise<number> {
  const result = await pool.query(
    `INSERT INTO memory.embedding_jobs (memory_id)
     SELECT n.id FROM memory.memory_nodes n
      WHERE n.status='active' AND n.embedding IS NULL
     ON CONFLICT (memory_id) DO UPDATE SET
       status=CASE WHEN memory.embedding_jobs.status='processing' THEN 'processing' ELSE 'pending' END,
       attempts=CASE WHEN memory.embedding_jobs.status IN ('failed','completed') THEN 0 ELSE memory.embedding_jobs.attempts END,
       available_at=CASE WHEN memory.embedding_jobs.status='processing' THEN memory.embedding_jobs.available_at ELSE now() END,
       completed_at=CASE WHEN memory.embedding_jobs.status='processing' THEN memory.embedding_jobs.completed_at ELSE NULL END,
       last_error=CASE WHEN memory.embedding_jobs.status='processing' THEN memory.embedding_jobs.last_error ELSE NULL END,
       updated_at=now()`
  );
  return result.rowCount ?? 0;
}

async function claimEmbeddingJob(): Promise<EmbeddingJob | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE memory.embedding_jobs SET status='pending',locked_at=NULL,locked_by=NULL,
              available_at=now(),last_error='Recovered after worker lease expired.',updated_at=now()
        WHERE status='processing' AND locked_at < now()-($1::int * interval '1 millisecond')`,
      [staleJobMs]
    );
    const result = await client.query<EmbeddingJob>(
      `WITH candidate AS (
         SELECT id FROM memory.embedding_jobs
          WHERE status='pending' AND available_at<=now()
          ORDER BY priority DESC,available_at,id
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE memory.embedding_jobs job SET status='processing',attempts=job.attempts+1,
              locked_at=now(),locked_by=$1,updated_at=now()
         FROM candidate WHERE job.id=candidate.id
       RETURNING job.id::text,job.memory_id,job.attempts,job.max_attempts,job.generation`,
      [workerId]
    );
    await client.query('COMMIT');
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function completeEmbeddingJob(job: EmbeddingJob, embedding: number[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const completed = await client.query(
      `UPDATE memory.embedding_jobs SET status='completed',completed_at=now(),locked_at=NULL,
              locked_by=NULL,last_error=NULL,updated_at=now()
        WHERE id=$1 AND generation=$2 AND status='processing' RETURNING memory_id`,
      [job.id, job.generation]
    );
    if (completed.rows[0]) {
      await client.query(
        `UPDATE memory.memory_nodes SET embedding=$2::vector,updated_at=now()
          WHERE id=$1 AND status='active'`,
        [job.memory_id, vectorParameter(embedding)]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function failEmbeddingJob(job: EmbeddingJob, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const failed = job.attempts >= job.max_attempts;
  const delaySeconds = Math.min(300, 5 * (2 ** Math.max(0, job.attempts - 1)));
  await pool.query(
    `UPDATE memory.embedding_jobs SET status=$3,available_at=now()+($4::int * interval '1 second'),
            locked_at=NULL,locked_by=NULL,last_error=$5,updated_at=now()
      WHERE id=$1 AND generation=$2 AND status='processing'`,
    [job.id, job.generation, failed ? 'failed' : 'pending', delaySeconds, message]
  );
}

export async function processEmbeddingJob(): Promise<boolean> {
  const settings = await resolveSettings();
  const definition = providerDefinition(settings.provider);
  if (!settings.enabled || !settings.endpoint || (definition.credentialRequired && !settings.apiKey)) return false;
  const job = await claimEmbeddingJob();
  if (!job) return false;
  try {
    const memory = await pool.query<{ title: string; summary: string; embedding: string | null }>(
      `SELECT title,summary,embedding::text FROM memory.memory_nodes WHERE id=$1 AND status='active'`,
      [job.memory_id]
    );
    if (!memory.rows[0] || memory.rows[0].embedding) {
      await pool.query(
        `UPDATE memory.embedding_jobs SET status='completed',completed_at=now(),locked_at=NULL,
                locked_by=NULL,last_error=NULL,updated_at=now()
          WHERE id=$1 AND generation=$2 AND status='processing'`,
        [job.id, job.generation]
      );
      return true;
    }
    const embedding = await createEmbedding(`${memory.rows[0].title}\n${memory.rows[0].summary}`);
    if (!embedding) throw new Error('Embedding provider did not return a vector.');
    await completeEmbeddingJob(job, embedding);
  } catch (error) {
    await failEmbeddingJob(job, error);
  }
  return true;
}

async function workerTick(): Promise<void> {
  if (workerStopping || workerRunning) return;
  workerRunning = true;
  try {
    await Promise.all(Array.from({ length: workerConcurrency }, () => processEmbeddingJob()));
  } catch (error) {
    console.error('Embedding queue worker failed.', error);
  } finally {
    workerRunning = false;
    if (!workerStopping) {
      workerTimer = setTimeout(() => void workerTick(), workerPollMs);
      workerTimer.unref();
    }
  }
}

export function startEmbeddingWorker(): void {
  if (workerTimer || workerRunning) return;
  workerStopping = false;
  void enqueueMissingEmbeddingJobs()
    .catch(error => console.error('Unable to enqueue missing embeddings.', error))
    .finally(() => void workerTick());
}

export function stopEmbeddingWorker(): void {
  workerStopping = true;
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
}

export async function backfillMissingEmbeddings(): Promise<EmbeddingState> {
  const state = await getEmbeddingState();
  if (!state.enabled) throw new Error('Enable semantic search before generating embeddings.');
  if (!state.configured) throw new Error('Complete the provider configuration before generating embeddings.');
  backfillRunning = true;
  try {
    await enqueueMissingEmbeddingJobs();
    if (!workerTimer && !workerRunning) startEmbeddingWorker();
  } finally {
    backfillRunning = false;
  }
  return getEmbeddingState();
}

async function localModelState() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
    const payload = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    const installed = new Set((payload.models ?? []).flatMap(item => [item.name, item.model]).filter(Boolean));
    return {
      available: true,
      models: embeddedModels.map(item => ({ ...item, installed: installed.has(item.id) })),
      install: localInstallState
    };
  } catch {
    return {
      available: false,
      models: embeddedModels.map(item => ({ ...item, installed: false })),
      install: localInstallState
    };
  }
}

function startLocalModelInstall(model: string): void {
  if (!embeddedModels.some(item => item.id === model)) throw new Error('Unsupported embedded model.');
  if (localInstallState.status === 'downloading') throw new Error(`Model ${localInstallState.model} is already downloading.`);
  localInstallState = { model, status: 'downloading' };
  void fetch(`${OLLAMA_URL}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false }),
    signal: AbortSignal.timeout(30 * 60_000)
  }).then(async response => {
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
    localInstallState = { model, status: 'ready' };
  }).catch(error => {
    localInstallState = { model, status: 'error', message: error instanceof Error ? error.message : 'Model download failed.' };
  });
}

export function registerEmbeddingSettingsRoutes(app: Express): void {
  app.get('/api/settings/embeddings', async (_req: Request, res: Response) => {
    try {
      res.json(await getEmbeddingState());
    } catch (error) {
      console.error('Unable to read embedding settings.', error);
      res.status(500).json({ error: 'Unable to read embedding settings.' });
    }
  });
  app.put('/api/settings/embeddings', async (req: Request, res: Response) => {
    try {
      const { enabled, provider, endpoint, model, apiKey, clearCredential } = req.body ?? {};
      if (typeof enabled !== 'boolean' || typeof provider !== 'string' || typeof endpoint !== 'string' || typeof model !== 'string') {
        res.status(400).json({ error: 'enabled, provider, endpoint and model are required.' });
        return;
      }
      if (!isProviderId(provider)) {
        res.status(400).json({ error: 'Unsupported embedding provider.' });
        return;
      }
      res.json(await saveEmbeddingSettings({ enabled, provider, endpoint, model, apiKey, clearCredential }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update embedding settings.';
      res.status(409).json({ error: message });
    }
  });
  app.post('/api/settings/embeddings/backfill', async (_req: Request, res: Response) => {
    try {
      if (backfillRunning) {
        res.status(202).json(await getEmbeddingState());
        return;
      }
      void backfillMissingEmbeddings().catch(error => console.error('Embedding backfill failed.', error));
      res.status(202).json({ ...(await getEmbeddingState()), backfillRunning: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start embedding backfill.';
      res.status(409).json({ error: message });
    }
  });
  app.post('/api/settings/embeddings/jobs/retry', async (_req: Request, res: Response) => {
    try {
      const retried = await pool.query(
        `UPDATE memory.embedding_jobs SET status='pending',attempts=0,available_at=now(),
                locked_at=NULL,locked_by=NULL,completed_at=NULL,last_error=NULL,updated_at=now()
          WHERE status='failed'`
      );
      res.status(202).json({ retried: retried.rowCount ?? 0, ...(await getEmbeddingState()) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to retry failed embedding jobs.';
      res.status(409).json({ error: message });
    }
  });
  app.get('/api/settings/embeddings/local', async (_req: Request, res: Response) => {
    res.json(await localModelState());
  });
  app.post('/api/settings/embeddings/local/install', async (req: Request, res: Response) => {
    try {
      if (typeof req.body?.model !== 'string') {
        res.status(400).json({ error: 'model is required.' });
        return;
      }
      startLocalModelInstall(req.body.model);
      res.status(202).json(await localModelState());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start the model download.';
      res.status(409).json({ error: message });
    }
  });
}

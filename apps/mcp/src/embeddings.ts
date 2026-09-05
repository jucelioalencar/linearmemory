import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Express, Request, Response } from 'express';
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
};

let backfillRunning = false;
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
  const stored = await readStoredSettings();
  const provider = providers.some(item => item.id === stored.provider) ? stored.provider! : 'openai';
  const definition = providerDefinition(provider);
  return {
    enabled: stored.enabled === true,
    provider,
    endpoint: stored.endpoint?.trim() || process.env.EMBEDDING_ENDPOINT?.trim() || definition.endpoint,
    model: stored.model?.trim() || process.env.EMBEDDING_MODEL?.trim() || definition.model,
    apiKey: decryptCredential(stored.encryptedApiKey) || process.env.EMBEDDING_API_KEY?.trim() || ''
  };
}

export async function getEmbeddingState(): Promise<EmbeddingState> {
  const [settings, counts] = await Promise.all([
    resolveSettings(),
    pool.query<{ total: string; embedded: string }>(
      `SELECT count(*) FILTER (WHERE status='active')::text AS total,
              count(*) FILTER (WHERE status='active' AND embedding IS NOT NULL)::text AS embedded
         FROM memory.memory_nodes`
    )
  ]);
  const definition = providerDefinition(settings.provider);
  const totalMemories = Number(counts.rows[0]?.total ?? 0);
  const embeddedMemories = Number(counts.rows[0]?.embedded ?? 0);
  const hasCredential = settings.apiKey.length > 0;
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
    backfillRunning
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
  if (input.enabled) void backfillMissingEmbeddings();
  return getEmbeddingState();
}

export async function createEmbedding(text: string): Promise<number[] | null> {
  const settings = await resolveSettings();
  const definition = providerDefinition(settings.provider);
  if (!settings.enabled || !settings.endpoint || (definition.credentialRequired && !settings.apiKey)) return null;
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
    return embedding;
  } catch (error) {
    console.error('Embedding generation failed; lexical search remains active.', error);
    return null;
  }
}

export function vectorParameter(embedding: number[] | null): string | null {
  return embedding ? `[${embedding.join(',')}]` : null;
}

export async function backfillMissingEmbeddings(): Promise<EmbeddingState> {
  if (backfillRunning) return getEmbeddingState();
  const state = await getEmbeddingState();
  if (!state.enabled) throw new Error('Enable semantic search before generating embeddings.');
  if (!state.configured) throw new Error('Complete the provider configuration before generating embeddings.');
  backfillRunning = true;
  try {
    while (true) {
      const batch = await pool.query<{ id: string; title: string; summary: string }>(
        `SELECT id,title,summary FROM memory.memory_nodes
          WHERE status='active' AND embedding IS NULL ORDER BY created_at LIMIT 25`
      );
      if (!batch.rowCount) break;
      let generated = 0;
      for (const memory of batch.rows) {
        const embedding = await createEmbedding(`${memory.title}\n${memory.summary}`);
        if (!embedding) continue;
        await pool.query(
          `UPDATE memory.memory_nodes SET embedding=$2::vector WHERE id=$1 AND embedding IS NULL`,
          [memory.id, vectorParameter(embedding)]
        );
        generated += 1;
      }
      if (generated === 0) break;
    }
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

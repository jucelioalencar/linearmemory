import { EventEmitter } from 'node:events';
import type pg from 'pg';

const liveEvents = new EventEmitter();
liveEvents.setMaxListeners(100);

export function subscribeToProtocolEvents(listener: (event: Record<string, unknown>) => void): () => void {
  liveEvents.on('event', listener);
  return () => liveEvents.off('event', listener);
}

export const protocolEventTypes = [
  'ContextStarted', 'MemorySearched', 'MemoryRead', 'ToolStarted', 'ToolFinished',
  'HypothesisCreated', 'DecisionMade', 'ArtifactCreated', 'ProgressUpdated',
  'ErrorOccurred', 'CorrectionMade', 'UserFeedbackReceived', 'MemoryLinked',
  'MemoryUnlinked', 'MemoryConsolidated', 'ReflectionRecorded', 'ExecutionCompleted'
] as const;

export const protocolSources = ['Agent', 'User', 'Tool', 'Memory', 'System'] as const;

export type ProtocolEventType = typeof protocolEventTypes[number];
export type ProtocolSource = typeof protocolSources[number];

export async function addProtocolEvent(
  client: pg.PoolClient,
  executionId: string,
  eventType: ProtocolEventType,
  title: string,
  description: string,
  source: ProtocolSource,
  metadata: Record<string, unknown> = {},
  confidence?: number,
  occurredAt?: string
) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [executionId]);
  const result = await client.query(
    `INSERT INTO memory.execution_events
       (execution_id, sequence, occurred_at, event_type, title, description, source, metadata, confidence)
     SELECT $1, COALESCE(max(sequence), 0) + 1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6, $7::jsonb, $8
       FROM memory.execution_events WHERE execution_id = $1
     RETURNING id, execution_id, sequence, occurred_at, event_type, title, description, source, metadata, confidence`,
    [executionId, occurredAt ?? null, eventType, title, description, source, JSON.stringify(metadata), confidence ?? null]
  );
  const event = result.rows[0];
  liveEvents.emit('event', event);
  return event;
}

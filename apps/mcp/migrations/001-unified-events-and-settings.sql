CREATE TABLE IF NOT EXISTS memory.system_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO memory.system_settings (key,value)
VALUES ('embeddings','{"enabled":false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE memory.execution_events
    DROP CONSTRAINT IF EXISTS execution_events_event_type_check;
ALTER TABLE memory.execution_events
    ADD CONSTRAINT execution_events_event_type_check CHECK (event_type IN (
        'ContextStarted', 'MemorySearched', 'MemoryRead', 'ToolStarted',
        'ToolFinished', 'HypothesisCreated', 'DecisionMade', 'ArtifactCreated',
        'ProgressUpdated', 'ErrorOccurred', 'CorrectionMade', 'UserFeedbackReceived',
        'MemoryLinked', 'MemoryUnlinked', 'MemoryConsolidated', 'ReflectionRecorded',
        'ExecutionCompleted'
    ));

ALTER TABLE memory.memory_nodes
    ADD COLUMN IF NOT EXISTS source_execution_event_id uuid
        REFERENCES memory.execution_events(id);

CREATE INDEX IF NOT EXISTS memory_nodes_source_execution_event_idx
    ON memory.memory_nodes (source_execution_event_id)
    WHERE source_execution_event_id IS NOT NULL;

WITH candidates AS (
    SELECT e.id AS legacy_event_id,
           CASE WHEN e.payload->>'executionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                THEN (e.payload->>'executionId')::uuid END AS execution_id,
           e.occurred_at,
           e.payload,
           n.id AS memory_id,
           row_number() OVER (
               PARTITION BY (e.payload->>'executionId')::uuid
               ORDER BY e.occurred_at,e.sequence
           ) AS offset_sequence
      FROM memory.memory_events e
      JOIN memory.memory_nodes n ON n.source_event_id=e.id
      JOIN memory.executions x ON x.id=CASE
          WHEN e.payload->>'executionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN (e.payload->>'executionId')::uuid END
     WHERE e.event_type='checkpoint'
       AND e.payload->>'executionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND NOT EXISTS (
           SELECT 1 FROM memory.execution_events pe
            WHERE pe.metadata->>'legacyEventId'=e.id::text
       )
), bases AS (
    SELECT execution_id,COALESCE(max(sequence),0) AS base_sequence
      FROM memory.execution_events
     GROUP BY execution_id
), inserted AS (
    INSERT INTO memory.execution_events
        (execution_id,sequence,occurred_at,event_type,title,description,source,metadata)
    SELECT c.execution_id,b.base_sequence+c.offset_sequence,c.occurred_at,
           'MemoryConsolidated',COALESCE(c.payload->>'title','Memory consolidated'),
           COALESCE(c.payload->>'summary','Legacy checkpoint migrated to the unified execution timeline.'),
           'Memory',jsonb_build_object('memoryId',c.memory_id,'legacyEventId',c.legacy_event_id)
      FROM candidates c
      JOIN bases b USING (execution_id)
    RETURNING id,metadata
)
UPDATE memory.memory_nodes n
   SET source_execution_event_id=i.id
  FROM inserted i
 WHERE n.id=(i.metadata->>'memoryId')::uuid;

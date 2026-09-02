\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS memory.knowledge_domains (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_key text NOT NULL UNIQUE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    tags text[] NOT NULL DEFAULT ARRAY[]::text[],
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE memory.workspaces
    ADD COLUMN IF NOT EXISTS domain_id uuid REFERENCES memory.knowledge_domains(id),
    ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT ARRAY[]::text[],
    ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS memory.executions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id uuid REFERENCES memory.knowledge_domains(id),
    workspace_id uuid NOT NULL REFERENCES memory.workspaces(id),
    session_id uuid NOT NULL REFERENCES memory.sessions(id),
    agent_id uuid NOT NULL REFERENCES memory.agents(id),
    goal text NOT NULL,
    user_request text NOT NULL,
    expected_outcome text,
    language text NOT NULL DEFAULT 'pt-BR',
    environment text NOT NULL DEFAULT 'unknown',
    model text,
    priority text NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'failed', 'cancelled')),
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
    final_response text,
    confidence real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    memory_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE memory.executions DROP COLUMN IF EXISTS protocol_version;

CREATE TABLE IF NOT EXISTS memory.execution_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id uuid NOT NULL REFERENCES memory.executions(id) ON DELETE CASCADE,
    sequence integer NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    event_type text NOT NULL CHECK (event_type IN (
        'ContextStarted', 'MemorySearched', 'MemoryRead', 'ToolStarted',
        'ToolFinished', 'HypothesisCreated', 'DecisionMade', 'ArtifactCreated',
        'ProgressUpdated', 'ErrorOccurred', 'CorrectionMade', 'UserFeedbackReceived',
        'MemoryLinked', 'MemoryUnlinked'
    )),
    title text NOT NULL,
    description text NOT NULL,
    source text NOT NULL DEFAULT 'Agent'
        CHECK (source IN ('Agent', 'User', 'Tool', 'Memory', 'System')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    confidence real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    UNIQUE (execution_id, sequence)
);

-- Keep existing installations aligned with the event types exposed by the MCP tools.
ALTER TABLE memory.execution_events
    DROP CONSTRAINT IF EXISTS execution_events_event_type_check;
ALTER TABLE memory.execution_events
    ADD CONSTRAINT execution_events_event_type_check CHECK (event_type IN (
        'ContextStarted', 'MemorySearched', 'MemoryRead', 'ToolStarted',
        'ToolFinished', 'HypothesisCreated', 'DecisionMade', 'ArtifactCreated',
        'ProgressUpdated', 'ErrorOccurred', 'CorrectionMade', 'UserFeedbackReceived',
        'MemoryLinked', 'MemoryUnlinked'
    ));

CREATE TABLE IF NOT EXISTS memory.reflections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id uuid NOT NULL REFERENCES memory.executions(id) ON DELETE CASCADE,
    what_worked text[] NOT NULL DEFAULT ARRAY[]::text[],
    what_failed text[] NOT NULL DEFAULT ARRAY[]::text[],
    assumptions text[] NOT NULL DEFAULT ARRAY[]::text[],
    lessons_learned text[] NOT NULL DEFAULT ARRAY[]::text[],
    suggested_improvements text[] NOT NULL DEFAULT ARRAY[]::text[],
    confidence real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_domains_search_idx
    ON memory.knowledge_domains USING gin ((name || ' ' || description) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workspaces_domain_idx ON memory.workspaces (domain_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspaces_search_idx
    ON memory.workspaces USING gin ((workspace_key || ' ' || coalesce(display_name, '') || ' ' || description) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS executions_workspace_started_idx
    ON memory.executions (workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS executions_agent_started_idx
    ON memory.executions (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS execution_events_timeline_idx
    ON memory.execution_events (execution_id, sequence);
CREATE INDEX IF NOT EXISTS reflections_execution_idx ON memory.reflections (execution_id, created_at DESC);

DROP TRIGGER IF EXISTS knowledge_domains_touch_updated_at ON memory.knowledge_domains;
CREATE TRIGGER knowledge_domains_touch_updated_at
BEFORE UPDATE ON memory.knowledge_domains
FOR EACH ROW EXECUTE FUNCTION memory.touch_updated_at();

DROP TRIGGER IF EXISTS workspaces_touch_updated_at ON memory.workspaces;
CREATE TRIGGER workspaces_touch_updated_at
BEFORE UPDATE ON memory.workspaces
FOR EACH ROW EXECUTE FUNCTION memory.touch_updated_at();

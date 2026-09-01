\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS graph;

CREATE SCHEMA IF NOT EXISTS memory;

CREATE TABLE memory.workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_key text NOT NULL UNIQUE,
    display_name text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory.agents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_key text NOT NULL UNIQUE,
    display_name text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory.sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES memory.workspaces(id),
    agent_id uuid REFERENCES memory.agents(id),
    external_session_key text,
    task text NOT NULL,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'failed', 'cancelled')),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (workspace_id, external_session_key)
);

CREATE TABLE memory.memory_events (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES memory.workspaces(id),
    session_id uuid REFERENCES memory.sessions(id),
    agent_id uuid REFERENCES memory.agents(id),
    event_type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key text,
    content_hash text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE memory.memory_nodes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES memory.workspaces(id),
    source_session_id uuid REFERENCES memory.sessions(id),
    source_event_id uuid REFERENCES memory.memory_events(id),
    node_type text NOT NULL
        CHECK (node_type IN ('fact', 'decision', 'preference', 'procedure', 'entity', 'task', 'artifact', 'hypothesis', 'question')),
    title text NOT NULL,
    summary text NOT NULL,
    content jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'superseded', 'invalidated', 'archived')),
    confidence real NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
    importance real NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
    valid_from timestamptz,
    valid_until timestamptz,
    content_hash text,
    embedding vector(1536),
    search_document tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(summary, '')), 'B')
    ) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, content_hash)
);

CREATE TABLE memory.memory_relations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES memory.workspaces(id),
    source_id uuid NOT NULL REFERENCES memory.memory_nodes(id) ON DELETE CASCADE,
    target_id uuid NOT NULL REFERENCES memory.memory_nodes(id) ON DELETE CASCADE,
    relation_type varchar(128) NOT NULL,
    weight integer NOT NULL DEFAULT 1 CHECK (weight > 0),
    confidence real NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
    evidence_event_id uuid REFERENCES memory.memory_events(id),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (source_id <> target_id),
    UNIQUE (workspace_id, source_id, target_id, relation_type)
);

CREATE TABLE memory.memory_conflicts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES memory.workspaces(id),
    memory_a_id uuid NOT NULL REFERENCES memory.memory_nodes(id),
    memory_b_id uuid NOT NULL REFERENCES memory.memory_nodes(id),
    conflict_type text NOT NULL,
    status text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'resolved', 'dismissed')),
    resolution jsonb,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (memory_a_id <> memory_b_id),
    UNIQUE (workspace_id, memory_a_id, memory_b_id, conflict_type)
);

CREATE INDEX memory_events_workspace_sequence_idx
    ON memory.memory_events (workspace_id, sequence DESC);
CREATE INDEX memory_events_session_idx
    ON memory.memory_events (session_id, sequence);
CREATE INDEX memory_nodes_workspace_status_idx
    ON memory.memory_nodes (workspace_id, status, created_at DESC);
CREATE INDEX memory_nodes_search_idx
    ON memory.memory_nodes USING gin (search_document);
CREATE INDEX memory_relations_source_idx
    ON memory.memory_relations (source_id, relation_type);
CREATE INDEX memory_relations_target_idx
    ON memory.memory_relations (target_id, relation_type);
CREATE INDEX memory_conflicts_open_idx
    ON memory.memory_conflicts (workspace_id, status) WHERE status = 'open';

CREATE OR REPLACE FUNCTION memory.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER memory_nodes_touch_updated_at
BEFORE UPDATE ON memory.memory_nodes
FOR EACH ROW EXECUTE FUNCTION memory.touch_updated_at();

CREATE OR REPLACE VIEW memory.timeline AS
SELECT
    e.sequence,
    e.id,
    w.workspace_key,
    s.task,
    a.agent_key,
    e.event_type,
    e.payload,
    e.occurred_at
FROM memory.memory_events e
JOIN memory.workspaces w ON w.id = e.workspace_id
LEFT JOIN memory.sessions s ON s.id = e.session_id
LEFT JOIN memory.agents a ON a.id = e.agent_id;

-- PostgreSQL remains the source of truth; pgGraph is a rebuildable projection.
SELECT graph.add_table(
    table_name := 'memory.memory_nodes'::regclass,
    id_column := 'id',
    columns := ARRAY['node_type', 'title', 'summary', 'status'],
    tenant_column := 'workspace_id'
);

SELECT graph.add_edge(
    from_table := 'memory.memory_relations'::regclass,
    from_column := 'source_id',
    to_table := 'memory.memory_nodes'::regclass,
    to_column := 'target_id',
    label := 'related_to',
    bidirectional := true,
    label_column := 'relation_type',
    weight_column := 'weight'
);

SELECT graph.add_filter_column(
    table_name := 'memory.memory_nodes'::regclass,
    column_name := 'workspace_id',
    column_type := 'uuid'
);

SELECT graph.add_filter_column(
    table_name := 'memory.memory_nodes'::regclass,
    column_name := 'status',
    column_type := 'text'
);

SELECT * FROM graph.build();

CREATE TABLE IF NOT EXISTS memory.embedding_jobs (
    id bigserial PRIMARY KEY,
    memory_id uuid NOT NULL UNIQUE REFERENCES memory.memory_nodes(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','completed','failed')),
    priority smallint NOT NULL DEFAULT 0,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
    generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
    available_at timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    locked_by text,
    completed_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS embedding_jobs_pending_idx
    ON memory.embedding_jobs (priority DESC,available_at,id)
    WHERE status='pending';

CREATE INDEX IF NOT EXISTS embedding_jobs_processing_idx
    ON memory.embedding_jobs (locked_at)
    WHERE status='processing';

INSERT INTO memory.embedding_jobs (memory_id)
SELECT id FROM memory.memory_nodes
 WHERE status='active' AND embedding IS NULL
ON CONFLICT (memory_id) DO NOTHING;

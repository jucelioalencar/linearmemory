CREATE INDEX IF NOT EXISTS memory_nodes_title_similarity_idx
    ON memory.memory_nodes USING gin (lower(title) gin_trgm_ops);

ANALYZE memory.memory_nodes;

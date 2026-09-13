CREATE INDEX IF NOT EXISTS memory_nodes_relation_title_idx
 ON memory.memory_nodes USING gist (title gist_trgm_ops(siglen=256)) WHERE status='active';
CREATE INDEX IF NOT EXISTS memory_nodes_relation_summary_idx
 ON memory.memory_nodes USING gist (summary gist_trgm_ops(siglen=256)) WHERE status='active';
CREATE INDEX IF NOT EXISTS memory_nodes_relation_text_idx
 ON memory.memory_nodes USING gist ((title || ' ' || summary) gist_trgm_ops(siglen=256)) WHERE status='active';

ALTER TABLE memory.reflections ADD COLUMN IF NOT EXISTS search_text text;
CREATE OR REPLACE FUNCTION memory.refresh_reflection_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.search_text := public.unaccent(array_to_string(NEW.lessons_learned || NEW.what_failed || NEW.what_worked,' '));
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reflection_search_text ON memory.reflections;
CREATE TRIGGER reflection_search_text BEFORE INSERT OR UPDATE ON memory.reflections
 FOR EACH ROW EXECUTE FUNCTION memory.refresh_reflection_search();
UPDATE memory.reflections SET search_text=public.unaccent(array_to_string(lessons_learned || what_failed || what_worked,' ')) WHERE search_text IS NULL;
CREATE INDEX IF NOT EXISTS reflections_search_text_idx ON memory.reflections USING gin(search_text gin_trgm_ops);
ANALYZE memory.memory_nodes;
ANALYZE memory.reflections;

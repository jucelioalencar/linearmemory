CREATE EXTENSION IF NOT EXISTS unaccent;

ALTER TABLE memory.executions ALTER COLUMN language SET DEFAULT 'en-US';

CREATE OR REPLACE FUNCTION memory.open_conflict_on_contradiction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.relation_type = 'contradicts' THEN
        INSERT INTO memory.memory_conflicts
            (workspace_id,memory_a_id,memory_b_id,conflict_type)
        VALUES
            (NEW.workspace_id,LEAST(NEW.source_id,NEW.target_id),GREATEST(NEW.source_id,NEW.target_id),NEW.relation_type)
        ON CONFLICT (workspace_id,memory_a_id,memory_b_id,conflict_type)
        DO UPDATE SET status='open',resolution=NULL,resolved_at=NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_relation_open_conflict ON memory.memory_relations;
CREATE TRIGGER memory_relation_open_conflict
AFTER INSERT OR UPDATE OF relation_type ON memory.memory_relations
FOR EACH ROW EXECUTE FUNCTION memory.open_conflict_on_contradiction();

CREATE OR REPLACE FUNCTION memory.close_conflict_on_relation_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.relation_type = 'contradicts' THEN
        UPDATE memory.memory_conflicts
           SET status='dismissed',resolution=jsonb_build_object('reason','relationship removed'),resolved_at=now()
         WHERE workspace_id=OLD.workspace_id
           AND memory_a_id=LEAST(OLD.source_id,OLD.target_id)
           AND memory_b_id=GREATEST(OLD.source_id,OLD.target_id)
           AND conflict_type='contradicts'
           AND status='open';
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS memory_relation_close_conflict ON memory.memory_relations;
CREATE TRIGGER memory_relation_close_conflict
AFTER DELETE ON memory.memory_relations
FOR EACH ROW EXECUTE FUNCTION memory.close_conflict_on_relation_delete();

INSERT INTO memory.memory_conflicts
    (workspace_id,memory_a_id,memory_b_id,conflict_type)
SELECT r.workspace_id,LEAST(r.source_id,r.target_id),GREATEST(r.source_id,r.target_id),'contradicts'
  FROM memory.memory_relations r
 WHERE r.relation_type='contradicts'
ON CONFLICT DO NOTHING;

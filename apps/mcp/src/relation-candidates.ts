// For max(title, summary, combined) similarity, every top-k result belongs to
// at least one branch's top-k. Keep the same secondary ordering in each branch.
export const relationCandidatesSql = `WITH eligible_workspaces AS MATERIALIZED (
  SELECT id FROM memory.workspaces WHERE ($2='Workspace' AND id=$5) OR ($2='Domain' AND domain_id=$6)
), nearest AS (
  (SELECT id FROM memory.memory_nodes WHERE status='active' AND id<>$1 AND workspace_id=ANY(ARRAY(SELECT id FROM eligible_workspaces)) ORDER BY title <-> $4,importance DESC,created_at DESC LIMIT $7)
  UNION
  (SELECT id FROM memory.memory_nodes WHERE status='active' AND id<>$1 AND workspace_id=ANY(ARRAY(SELECT id FROM eligible_workspaces)) ORDER BY summary <-> $4,importance DESC,created_at DESC LIMIT $7)
  UNION
  (SELECT id FROM memory.memory_nodes WHERE status='active' AND id<>$1 AND workspace_id=ANY(ARRAY(SELECT id FROM eligible_workspaces)) ORDER BY (title || ' ' || summary) <-> $4,importance DESC,created_at DESC LIMIT $7)
), matched AS MATERIALIZED (
  SELECT id,node_type,title,summary,confidence,importance,created_at,workspace_id,source_session_id
  FROM memory.memory_nodes WHERE id IN (SELECT id FROM nearest)
    AND GREATEST(similarity(title || ' ' || summary,$4),similarity(title,$4),similarity(summary,$4)) >= $3
)
SELECT n.id,n.node_type,n.title,n.summary,n.confidence,n.importance,
  w.workspace_key,d.domain_key,COALESCE(a.agent_key,'agent_default') AS agent_key,
  GREATEST(similarity(n.title || ' ' || n.summary,$4),similarity(n.title,$4),similarity(n.summary,$4)) AS similarity
FROM matched n
JOIN memory.workspaces w ON w.id=n.workspace_id
JOIN memory.knowledge_domains d ON d.id=w.domain_id
LEFT JOIN memory.sessions s ON s.id=n.source_session_id
LEFT JOIN memory.agents a ON a.id=s.agent_id
WHERE (($2='Workspace' AND n.workspace_id=$5) OR ($2='Domain' AND w.domain_id=$6))
ORDER BY similarity DESC,n.importance DESC,n.created_at DESC LIMIT $7`;

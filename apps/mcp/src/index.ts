import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { pool, ensureAgent } from './db.js';
import { addProtocolEvent, protocolEventTypes, protocolSources, subscribeToProtocolEvents } from './events.js';
import { createEmbedding, registerEmbeddingSettingsRoutes, vectorParameter } from './embeddings.js';
import { createDomain, createWorkspace, updateDomain, updateWorkspace } from './catalog.js';
import { createOrReuseSession, finishSessionIfIdle } from './sessions.js';
import { registerBackupRoutes } from './backup.js';
import { performanceMiddleware, performanceSummary, recordPerformance } from './performance.js';

const memoryRelationTypes = [
  'supports', 'depends_on', 'caused', 'contradicts', 'refines', 'implements',
  'validates', 'supersedes', 'related_to'
] as const;

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>
  };
}

function createServer(): McpServer {
  const server = new McpServer({ name: 'linearmemory', version: '0.2.0' });

  server.registerTool(
    'find_domain',
    {
      description: `Call before choosing or creating a workspace. Find an existing stable knowledge domain, such as a product, organization or long-lived initiative. A domain groups multiple workspaces and executions. This tool is read-only and never creates data. Prefer a returned domain when it describes the same real-world subject.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        searchText: z.string().min(1).describe('Product, organization or durable subject to find, written as a short natural-language phrase.'),
        tags: z.array(z.string().min(1)).default([]).describe('Optional concepts that the domain should contain.'),
        similarityThreshold: z.number().min(0).max(1).default(0.25).describe('Minimum text similarity from 0 to 1. Use 0.25 unless exact matching is required.'),
        limit: z.number().int().min(1).max(20).default(5).describe('Maximum number of candidate domains to return.')
      })
    },
    async ({ searchText, tags, similarityThreshold, limit }) => {
      const result = await pool.query(
        `SELECT id, domain_key, name, description, tags, metadata, created_at,
                GREATEST(similarity(name, $1), similarity(domain_key, $1), similarity(description, $1)) AS similarity
           FROM memory.knowledge_domains
          WHERE GREATEST(similarity(name, $1), similarity(domain_key, $1), similarity(description, $1)) >= $2
            AND (cardinality($3::text[]) = 0 OR tags && $3::text[])
          ORDER BY similarity DESC, updated_at DESC LIMIT $4`,
        [searchText, similarityThreshold, tags, limit]
      );
      return jsonResult({ candidates: result.rows, shouldCreate: result.rows.length === 0 });
    }
  );

  server.registerTool(
    'create_domain',
    {
      description: `Create a stable knowledge domain only after find_domain returned no suitable candidate. Domains are long-lived subjects above workspaces; do not create one per task, chat or agent.`,
      inputSchema: z.object({
        domainKey: z.string().min(2).regex(/^[a-z0-9][a-z0-9_-]*$/).describe('Stable lowercase identifier, for example sol-agora. Never use a session or execution identifier.'),
        name: z.string().min(2).describe('Human-readable durable domain name, for example Sol Agora.'),
        description: z.string().min(12).describe('What knowledge belongs in this domain and what should remain outside it.'),
        tags: z.array(z.string().min(1)).default([]).describe('Stable concepts used to find this domain later.'),
        metadata: z.record(z.string(), z.unknown()).default({}).describe('Optional non-sensitive integration identifiers. Do not store reasoning or prompts here.')
      })
    },
    async ({ domainKey, name, description, tags, metadata }) => {
      return jsonResult(await createDomain(pool, { domainKey, name, description, tags, metadata }));
    }
  );

  server.registerTool(
    'update_domain',
    {
      description: `Explicitly update an existing knowledge domain. Never call this as a fallback for create_domain. Supply only intentional changes and an observable reason so edits remain auditable. The stable domainKey cannot be changed.`,
      inputSchema: z.object({
        domainId: z.string().uuid(),
        name: z.string().min(2).optional(),
        description: z.string().min(12).optional(),
        tags: z.array(z.string().min(1)).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        reason: z.string().min(12).describe('Observable reason the domain definition needs to change.')
      })
    },
    async input => jsonResult(await updateDomain(pool, input))
  );

  server.registerTool(
    'find_workspace',
    {
      description: `Call before suggest_workspace or create_workspace. Find an existing workspace inside a domain that already represents the task area. A workspace is a bounded project or stream of work, not a single execution. Reuse a suitable candidate to prevent fragmented memory.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        domainId: z.string().uuid().describe('Knowledge domain selected with find_domain.'),
        searchText: z.string().min(1).describe('Project, component or work stream to find. Describe the subject, not the current action.'),
        tags: z.array(z.string().min(1)).default([]).describe('Optional workspace concepts that should overlap.'),
        similarityThreshold: z.number().min(0).max(1).default(0.25).describe('Minimum text similarity from 0 to 1. Use 0.25 for normal discovery.'),
        limit: z.number().int().min(1).max(20).default(5)
      })
    },
    async ({ domainId, searchText, tags, similarityThreshold, limit }) => {
      const result = await pool.query(
        `SELECT id, domain_id, workspace_key, display_name, description, tags, metadata, created_at,
                GREATEST(similarity(workspace_key, $2), similarity(coalesce(display_name,''), $2), similarity(description, $2)) AS similarity
           FROM memory.workspaces
          WHERE domain_id=$1
            AND GREATEST(similarity(workspace_key, $2), similarity(coalesce(display_name,''), $2), similarity(description, $2)) >= $3
            AND (cardinality($4::text[]) = 0 OR tags && $4::text[])
          ORDER BY similarity DESC, updated_at DESC LIMIT $5`,
        [domainId, searchText, similarityThreshold, tags, limit]
      );
      return jsonResult({ candidates: result.rows, shouldSuggest: result.rows.length === 0 });
    }
  );

  server.registerTool(
    'suggest_workspace',
    {
      description: `Use only when find_workspace found no suitable workspace. Produce a normalized workspace proposal and show nearby candidates; this tool does not create anything. The LLM should present or evaluate the proposal before calling create_workspace.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        domainId: z.string().uuid().describe('Parent domain for the proposed workspace.'),
        subject: z.string().min(2).describe('Stable project or work-stream subject, not a one-time task.'),
        purpose: z.string().min(12).describe('Boundary and durable purpose of this workspace.'),
        tags: z.array(z.string().min(1)).default([])
      })
    },
    async ({ domainId, subject, purpose, tags }) => {
      const normalizedKey = subject.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'workspace';
      const nearby = await pool.query(
        `SELECT id, workspace_key, display_name, description,
                GREATEST(similarity(workspace_key,$2), similarity(coalesce(display_name,''),$2), similarity(description,$2)) AS similarity
           FROM memory.workspaces WHERE domain_id=$1
          ORDER BY similarity DESC LIMIT 5`, [domainId, subject]
      );
      return jsonResult({ proposal: { domainId, workspaceKey: normalizedKey, name: subject, description: purpose, tags }, nearbyCandidates: nearby.rows, created: false });
    }
  );

  server.registerTool(
    'create_workspace',
    {
      description: `Create a bounded workspace after find_workspace and suggest_workspace. Never create one per prompt, agent, session or execution. workspaceKey must remain stable and unique.`,
      inputSchema: z.object({
        domainId: z.string().uuid().describe('Existing parent knowledge domain.'),
        workspaceKey: z.string().min(2).regex(/^[a-z0-9][a-z0-9_-]*$/).describe('Stable lowercase project identifier.'),
        name: z.string().min(2).describe('Human-readable project or work-stream name.'),
        description: z.string().min(12).describe('What belongs in this workspace and its durable objective.'),
        tags: z.array(z.string().min(1)).default([]),
        creationReason: z.string().min(12).describe('Why existing workspace candidates were not suitable. This is audit context, not private reasoning.'),
        metadata: z.record(z.string(), z.unknown()).default({})
      })
    },
    async ({ domainId, workspaceKey, name, description, tags, creationReason, metadata }) => {
      return jsonResult(await createWorkspace(pool, { domainId, workspaceKey, name, description, tags, creationReason, metadata }));
    }
  );

  server.registerTool(
    'update_workspace',
    {
      description: `Explicitly update an existing workspace definition. The stable workspaceKey and parent domain cannot be changed. Supply only intentional changes and an observable reason.`,
      inputSchema: z.object({
        workspaceId: z.string().uuid(),
        name: z.string().min(2).optional(),
        description: z.string().min(12).optional(),
        tags: z.array(z.string().min(1)).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        reason: z.string().min(12).describe('Observable reason the workspace definition needs to change.')
      })
    },
    async input => jsonResult(await updateWorkspace(pool, input))
  );

  server.registerTool(
    'begin_context',
    {
      description: `Begin one observable execution after the domain and workspace have been selected. Record identity, objective and original request only. Do not include chain-of-thought, hidden reasoning, hypotheses or conclusions here. After this call, call search_memory before creating artifacts or durable memory. Omitted agentId is stored as agent_default.`,
      inputSchema: z.object({
        agentId: z.string().min(1).optional().describe('Calling LLM or agent identity. Omit only when it is unknown; the server then uses agent_default.'),
        domainId: z.string().uuid().describe('Stable knowledge domain selected before this execution.'),
        workspaceId: z.string().uuid().describe('Existing workspace selected with find_workspace.'),
        sessionId: z.string().uuid().optional().describe('Caller-provided session UUID when one already exists; otherwise omit and the server generates it.'),
        executionId: z.string().uuid().optional().describe('Caller-provided execution UUID for end-to-end tracing; otherwise omit and the server generates it.'),
        goal: z.string().min(1).describe('Concrete objective this execution must achieve.'),
        userRequest: z.string().min(1).describe('Original user request, preserved verbatim when practical. Do not add hidden instructions or reasoning.'),
        expectedOutcome: z.string().min(1).optional().describe('Observable result that would make this execution successful.'),
        language: z.string().min(2).default('en-US').describe('BCP-47 language used for user-facing output, for example en-US, es-ES or pt-BR.'),
        environment: z.string().min(1).describe('Execution environment, for example local-docker, production or ci.'),
        model: z.string().min(1).optional().describe('Model identifier when known.'),
        priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
        metadata: z.record(z.string(), z.unknown()).default({}).describe('Optional trace or integration identifiers; never store private reasoning.')
      })
    },
    async ({ agentId: agentKey, domainId, workspaceId, sessionId, executionId, goal, userRequest, expectedOutcome, language, environment, model, priority, metadata }) => {
      const resolvedAgentId = await ensureAgent(agentKey);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const workspace = await client.query('SELECT id FROM memory.workspaces WHERE id=$1 AND domain_id=$2', [workspaceId, domainId]);
        if (!workspace.rows[0]) throw new Error('Workspace does not belong to the selected domain. Call find_workspace again.');
        const resolvedSessionId = await createOrReuseSession(client, { sessionId, workspaceId, agentId: resolvedAgentId, task: goal, metadata: { environment } });
        const execution = await client.query(
          `INSERT INTO memory.executions
             (id, domain_id, workspace_id, session_id, agent_id, goal, user_request,
              expected_outcome, language, environment, model, priority, metadata)
           VALUES (COALESCE($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
           RETURNING id, domain_id, workspace_id, session_id, goal, status, started_at`,
          [executionId ?? null, domainId, workspaceId, resolvedSessionId, resolvedAgentId, goal, userRequest, expectedOutcome ?? null, language, environment, model ?? null, priority, JSON.stringify(metadata)]
        );
        const contextEvent = await addProtocolEvent(client, execution.rows[0].id, 'ContextStarted', 'Execution context started', goal, 'System', { language, environment, priority });
        await client.query('COMMIT');
        return jsonResult({ execution: execution.rows[0], event: contextEvent, nextRequiredAction: 'Call search_memory before creating artifacts or durable memory.' });
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
  );

  server.registerTool(
    'search_memory',
    {
      description: `Call immediately after begin_context and whenever prior knowledge may affect a decision. Searches durable facts and decisions; it does not expose reflections as facts. Read relevant results and record MemoryRead with add_execution_event when a result actually influenced the work.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        executionId: z.string().uuid().describe('Active execution returned by begin_context.'),
        query: z.string().min(1).describe('Focused description of the decision, problem, entity or result to recall; do not send the full conversation.'),
        scope: z.enum(['Workspace', 'Domain']).default('Workspace').describe('Workspace searches the selected project. Domain can reuse knowledge across workspaces in the same domain.'),
        memoryTypes: z.array(z.enum(['fact','decision','preference','procedure','entity','task','artifact','hypothesis','question'])).default([]),
        limit: z.number().int().min(1).max(50).default(10)
      })
    },
    async ({ executionId, query, scope, memoryTypes, limit }) => {
      const searchStartedAt = performance.now();
      const embeddingStartedAt = performance.now();
      const queryEmbedding = await createEmbedding(query);
      const embeddingDurationMs = performance.now() - embeddingStartedAt;
      const queryVector = vectorParameter(queryEmbedding);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const execution = await client.query<{ workspace_id: string; domain_id: string; language: string }>('SELECT workspace_id, domain_id, language FROM memory.executions WHERE id=$1 AND status=\'active\'', [executionId]);
        if (!execution.rows[0]) throw new Error('Active execution not found. Call begin_context first.');
        await client.query(`SET LOCAL pg_trgm.similarity_threshold = '0.15'`);
        const databaseStartedAt = performance.now();
        const memories = await client.query(
          `WITH candidates AS (
             SELECT n.id,n.node_type,n.title,n.summary,n.content,n.confidence,n.importance,n.created_at,
                    w.id AS workspace_id,w.workspace_key,COALESCE(a.agent_key,'agent_default') AS agent_id,
                    ts_rank_cd(n.search_document,plainto_tsquery('simple', $2))
                      + similarity(lower(n.title),lower($2)) AS lexical_relevance,
                    CASE WHEN $7::vector IS NULL OR n.embedding IS NULL THEN 0
                         ELSE GREATEST(0,1-(n.embedding <=> $7::vector)) END AS semantic_relevance
               FROM memory.memory_nodes n
               JOIN memory.workspaces w ON w.id=n.workspace_id
               LEFT JOIN memory.sessions s ON s.id=n.source_session_id
               LEFT JOIN memory.agents a ON a.id=s.agent_id
              WHERE n.status='active'
                AND (($3='Workspace' AND w.id=$1) OR ($3='Domain' AND w.domain_id=$4))
                AND (cardinality($5::text[])=0 OR n.node_type=ANY($5::text[]))
                AND (n.search_document @@ plainto_tsquery('simple', $2)
                     OR lower(n.title) % lower($2)
                     OR ($7::vector IS NOT NULL AND n.embedding IS NOT NULL))
           )
           SELECT *,CASE WHEN $7::vector IS NULL THEN lexical_relevance
                         ELSE (.55*LEAST(1,lexical_relevance))+(.45*semantic_relevance) END AS relevance
             FROM candidates
            WHERE lexical_relevance > .08 OR ($7::vector IS NOT NULL AND semantic_relevance > .35)
            ORDER BY relevance DESC,importance DESC,created_at DESC LIMIT $6`,
          [execution.rows[0].workspace_id, query, scope, execution.rows[0].domain_id, memoryTypes, limit, queryVector]
        );
        const databaseDurationMs = performance.now() - databaseStartedAt;
        const event = await addProtocolEvent(client, executionId, 'MemorySearched', 'Durable memory searched', query, 'Memory', {
          scope,
          resultCount: memories.rowCount ?? 0,
          semanticSearchUsed: queryEmbedding !== null,
          resultMemoryIds: memories.rows.map(memory => memory.id),
          results: memories.rows.map(memory => ({
            id: memory.id,
            title: memory.title,
            summary: memory.summary,
            lexicalRelevance: Number(memory.lexical_relevance ?? 0),
            semanticRelevance: Number(memory.semantic_relevance ?? 0),
            relevance: Number(memory.relevance ?? 0)
          }))
        });
        await client.query('COMMIT');
        recordPerformance({
          operation: 'search_memory.database',
          category: 'query',
          durationMs: Number(databaseDurationMs.toFixed(2)),
          statusCode: 200,
          timestamp: new Date().toISOString()
        });
        recordPerformance({
          operation: 'search_memory.embedding',
          category: 'query',
          durationMs: Number(embeddingDurationMs.toFixed(2)),
          statusCode: 200,
          timestamp: new Date().toISOString()
        });
        recordPerformance({
          operation: 'search_memory.total',
          category: 'query',
          durationMs: Number((performance.now() - searchStartedAt).toFixed(2)),
          statusCode: 200,
          timestamp: new Date().toISOString()
        });
        return jsonResult({ results: memories.rows, searchEvent: event, instruction: 'For each result that affects the work, call add_execution_event with eventType MemoryRead and include memoryId in metadata.' });
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
  );

  server.registerTool(
    'add_execution_event',
    {
      description: `Append one small, observable event during an active execution. Record what happened, not private chain-of-thought. Use ToolStarted/ToolFinished around meaningful tool calls, MemoryRead when retrieved memory influenced work, HypothesisCreated for a testable provisional idea, DecisionMade for a chosen course, and ErrorOccurred/CorrectionMade for failures and corrections.`,
      inputSchema: z.object({
        executionId: z.string().uuid(),
        timestamp: z.string().datetime({ offset: true }).optional().describe('When the event occurred. Omit to use server time.'),
        eventType: z.enum(protocolEventTypes).describe('Closed event category describing the observable action.'),
        title: z.string().min(2).max(160).describe('Short human-readable event label.'),
        description: z.string().min(2).describe('What happened and why it matters operationally, without hidden reasoning.'),
        source: z.enum(protocolSources).default('Agent').describe('Origin of the observable event.'),
        metadata: z.record(z.string(), z.unknown()).default({}).describe('Structured identifiers and measurements, such as toolName, memoryId, artifactPath or errorCode.'),
        confidence: z.number().min(0).max(1).optional().describe('Confidence in an observation, hypothesis or decision; omit when not meaningful.')
      })
    },
    async ({ executionId, timestamp, eventType, title, description, source, metadata, confidence }) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const active = await client.query('SELECT id FROM memory.executions WHERE id=$1 AND status=\'active\'', [executionId]);
        if (!active.rows[0]) throw new Error('Active execution not found.');
        const event = await addProtocolEvent(client, executionId, eventType, title, description, source, metadata, confidence, timestamp);
        await client.query('COMMIT');
        return jsonResult(event);
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
  );

  server.registerTool(
    'find_memory_relations',
    {
      description: `Call before link_memories. Inspect the relationships already connected to one durable memory and find plausible candidates without changing data. Use Workspace scope for the current project and Domain scope when knowledge may connect different workspaces or agents. Candidate scores are discovery hints only: the LLM must read both memories and decide whether a precise, explainable relation really exists.` ,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        executionId: z.string().uuid().describe('Active execution returned by begin_context. It defines the authorized domain and workspace.'),
        memoryId: z.string().uuid().describe('Durable source memory to inspect. It must belong to the active execution domain.'),
        scope: z.enum(['Workspace', 'Domain']).default('Workspace').describe('Workspace considers only the execution workspace. Domain also considers memories from other workspaces and agents in the same domain.'),
        searchText: z.string().min(2).optional().describe('Optional focused concept for candidate discovery. Omit to compare candidates with the source memory title and summary.'),
        similarityThreshold: z.number().min(0).max(1).default(0.08).describe('Minimum lexical similarity for candidates. Use 0.08 for broad discovery; never treat this score as proof of a relationship.'),
        limit: z.number().int().min(1).max(50).default(15).describe('Maximum number of candidate memories to return.')
      })
    },
    async ({ executionId, memoryId, scope, searchText, similarityThreshold, limit }) => {
      const context = await pool.query<{
        workspace_id: string; domain_id: string; source_workspace_id: string;
        source_title: string; source_summary: string;
      }>(
        `SELECT x.workspace_id,x.domain_id,n.workspace_id AS source_workspace_id,
                n.title AS source_title,n.summary AS source_summary
           FROM memory.executions x
           JOIN memory.memory_nodes n ON n.id=$2 AND n.status='active'
           JOIN memory.workspaces source_workspace ON source_workspace.id=n.workspace_id
          WHERE x.id=$1 AND x.status='active' AND source_workspace.domain_id=x.domain_id`,
        [executionId, memoryId]
      );
      if (!context.rows[0]) throw new Error('Active execution or source memory not found in the execution domain.');
      const source = context.rows[0];
      const comparisonText = searchText ?? `${source.source_title} ${source.source_summary}`;
      const [existing, candidates] = await Promise.all([
        pool.query(
          `SELECT r.id,r.source_id,r.target_id,r.relation_type,r.weight,r.confidence,r.metadata,r.created_at,
                  source_node.title AS source_title,target_node.title AS target_title,
                  source_workspace.workspace_key AS source_workspace_key,
                  target_workspace.workspace_key AS target_workspace_key,
                  COALESCE(source_agent.agent_key,'agent_default') AS source_agent_key,
                  COALESCE(target_agent.agent_key,'agent_default') AS target_agent_key
             FROM memory.memory_relations r
             JOIN memory.memory_nodes source_node ON source_node.id=r.source_id
             JOIN memory.memory_nodes target_node ON target_node.id=r.target_id
             JOIN memory.workspaces source_workspace ON source_workspace.id=source_node.workspace_id
             JOIN memory.workspaces target_workspace ON target_workspace.id=target_node.workspace_id
             LEFT JOIN memory.sessions source_session ON source_session.id=source_node.source_session_id
             LEFT JOIN memory.sessions target_session ON target_session.id=target_node.source_session_id
             LEFT JOIN memory.agents source_agent ON source_agent.id=source_session.agent_id
             LEFT JOIN memory.agents target_agent ON target_agent.id=target_session.agent_id
            WHERE r.source_id=$1 OR r.target_id=$1
            ORDER BY r.confidence DESC,r.created_at DESC`,
          [memoryId]
        ),
        pool.query(
          `SELECT n.id,n.node_type,n.title,n.summary,n.confidence,n.importance,
                  w.workspace_key,d.domain_key,COALESCE(a.agent_key,'agent_default') AS agent_key,
                  GREATEST(similarity(n.title || ' ' || n.summary,$4),
                           similarity(n.title,$4),similarity(n.summary,$4)) AS similarity
             FROM memory.memory_nodes n
             JOIN memory.workspaces w ON w.id=n.workspace_id
             JOIN memory.knowledge_domains d ON d.id=w.domain_id
             LEFT JOIN memory.sessions s ON s.id=n.source_session_id
             LEFT JOIN memory.agents a ON a.id=s.agent_id
            WHERE n.id<>$1 AND n.status='active'
              AND (($2='Workspace' AND n.workspace_id=$5) OR ($2='Domain' AND w.domain_id=$6))
              AND GREATEST(similarity(n.title || ' ' || n.summary,$4),
                           similarity(n.title,$4),similarity(n.summary,$4)) >= $3
            ORDER BY similarity DESC,n.importance DESC,n.created_at DESC LIMIT $7`,
          [memoryId, scope, similarityThreshold, comparisonText, source.workspace_id, source.domain_id, limit]
        )
      ]);
      return jsonResult({
        sourceMemory: { id: memoryId, title: source.source_title, summary: source.source_summary },
        existingRelations: existing.rows,
        candidates: candidates.rows,
        instruction: 'Read both memories. Call link_memories only when the direction, relationType, explanation and evidence are explicit; otherwise leave them unrelated.'
      });
    }
  );

  server.registerTool(
    'link_memories',
    {
      description: `Create or update one explicit directed relationship between two durable memories after find_memory_relations. Both memories must belong to the active execution domain; they may come from different workspaces or agents. Direction matters: sourceMemoryId is the subject and targetMemoryId is the object (for example A implements B). Never link memories merely because they share words, chronology or an agent. Provide a human-readable explanation and concrete evidence so the graph remains trustworthy.` ,
      inputSchema: z.object({
        executionId: z.string().uuid().describe('Active execution authorizing and auditing this relationship.'),
        sourceMemoryId: z.string().uuid().describe('Memory where the directed relationship starts; read this memory before linking.'),
        targetMemoryId: z.string().uuid().describe('Memory where the directed relationship ends; must differ from sourceMemoryId.'),
        relationType: z.enum(memoryRelationTypes).describe('Precise semantic verb: supports, depends_on, caused, contradicts, refines, implements, validates, supersedes or related_to. Prefer a precise type over related_to.'),
        explanation: z.string().min(12).describe('One human-readable sentence explaining how the source relates to the target and why this edge is useful.'),
        evidence: z.array(z.string().min(2)).min(1).max(10).describe('Concrete facts, results, identifiers or observations supporting the relationship. Do not include private reasoning.'),
        confidence: z.number().min(0).max(1).default(0.8).describe('Confidence that the semantic relationship is correct, not confidence in either memory alone.'),
        weight: z.number().int().min(1).max(10).default(1).describe('Relative graph strength from 1 to 10. Use 1 normally; reserve higher values for repeatedly validated or structurally important connections.'),
        metadata: z.record(z.string(), z.unknown()).default({}).describe('Optional non-sensitive structured provenance. explanation and evidence are stored automatically.')
      })
    },
    async ({ executionId, sourceMemoryId, targetMemoryId, relationType, explanation, evidence, confidence, weight, metadata }) => {
      if (sourceMemoryId === targetMemoryId) throw new Error('A memory cannot be linked to itself.');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const context = await client.query<{
          domain_id: string; agent_key: string; source_workspace_id: string;
          source_title: string; target_title: string; source_agent_key: string; target_agent_key: string;
        }>(
          `SELECT x.domain_id,COALESCE(execution_agent.agent_key,'agent_default') AS agent_key,
                  source_node.workspace_id AS source_workspace_id,
                  source_node.title AS source_title,target_node.title AS target_title,
                  COALESCE(source_agent.agent_key,'agent_default') AS source_agent_key,
                  COALESCE(target_agent.agent_key,'agent_default') AS target_agent_key
             FROM memory.executions x
             JOIN memory.memory_nodes source_node ON source_node.id=$2 AND source_node.status='active'
             JOIN memory.memory_nodes target_node ON target_node.id=$3 AND target_node.status='active'
             JOIN memory.workspaces source_workspace ON source_workspace.id=source_node.workspace_id AND source_workspace.domain_id=x.domain_id
             JOIN memory.workspaces target_workspace ON target_workspace.id=target_node.workspace_id AND target_workspace.domain_id=x.domain_id
             LEFT JOIN memory.sessions source_session ON source_session.id=source_node.source_session_id
             LEFT JOIN memory.sessions target_session ON target_session.id=target_node.source_session_id
             LEFT JOIN memory.agents execution_agent ON execution_agent.id=x.agent_id
             LEFT JOIN memory.agents source_agent ON source_agent.id=source_session.agent_id
             LEFT JOIN memory.agents target_agent ON target_agent.id=target_session.agent_id
            WHERE x.id=$1 AND x.status='active'`,
          [executionId, sourceMemoryId, targetMemoryId]
        );
        if (!context.rows[0]) throw new Error('Active execution not found, or memories are not active members of its domain.');
        const c = context.rows[0];
        const relation = await client.query(
          `INSERT INTO memory.memory_relations
             (workspace_id,source_id,target_id,relation_type,weight,confidence,metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
           ON CONFLICT (workspace_id,source_id,target_id,relation_type) DO UPDATE SET
             weight=EXCLUDED.weight,confidence=EXCLUDED.confidence,
             metadata=memory.memory_relations.metadata || EXCLUDED.metadata
           RETURNING id,source_id,target_id,relation_type,weight,confidence,metadata,created_at`,
          [c.source_workspace_id, sourceMemoryId, targetMemoryId, relationType, weight, confidence,
           JSON.stringify({ ...metadata, explanation, evidence, executionId, linkedByAgent: c.agent_key })]
        );
        const auditEvent = await addProtocolEvent(
          client, executionId, 'MemoryLinked', 'Durable memories linked',
          `${c.source_title} ${relationType} ${c.target_title}`, 'Memory',
          { relationId: relation.rows[0].id, sourceMemoryId, targetMemoryId, relationType, explanation }, confidence
        );
        await client.query('COMMIT');
        return jsonResult({
          relation: relation.rows[0],
          auditEvent,
          crossesAgents: c.source_agent_key !== c.target_agent_key,
          sourceAgentId: c.source_agent_key,
          targetAgentId: c.target_agent_key
        });
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
  );

  server.registerTool(
    'unlink_memories',
    {
      description: `Remove one incorrect, obsolete or accidentally duplicated memory relationship. Use the relation id returned by find_memory_relations, explain why the edge is invalid, and prefer supersedes or contradicts instead when the historical relationship should remain visible.` ,
      annotations: { destructiveHint: true, idempotentHint: true },
      inputSchema: z.object({
        executionId: z.string().uuid().describe('Active execution authorizing and auditing the removal.'),
        relationId: z.string().uuid().describe('Exact relationship identifier returned by find_memory_relations.'),
        reason: z.string().min(12).describe('Observable reason this edge is wrong or no longer useful. Do not provide private reasoning.')
      })
    },
    async ({ executionId, relationId, reason }) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const relation = await client.query(
          `DELETE FROM memory.memory_relations r
            USING memory.memory_nodes source_node,memory.memory_nodes target_node,
                  memory.workspaces source_workspace,memory.workspaces target_workspace,
                  memory.executions x
            WHERE r.id=$2 AND source_node.id=r.source_id AND target_node.id=r.target_id
              AND source_workspace.id=source_node.workspace_id AND target_workspace.id=target_node.workspace_id
              AND x.id=$1 AND x.status='active'
              AND source_workspace.domain_id=x.domain_id AND target_workspace.domain_id=x.domain_id
          RETURNING r.id,r.source_id,r.target_id,r.relation_type,r.metadata`,
          [executionId, relationId]
        );
        if (!relation.rows[0]) throw new Error('Relationship not found in the active execution domain.');
        const auditEvent = await addProtocolEvent(
          client, executionId, 'MemoryUnlinked', 'Durable memory relationship removed', reason, 'Memory',
          { relationId, sourceMemoryId: relation.rows[0].source_id, targetMemoryId: relation.rows[0].target_id, relationType: relation.rows[0].relation_type }
        );
        await client.query('COMMIT');
        return jsonResult({ removed: true, relation: relation.rows[0], reason, auditEvent });
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
  );

  server.registerTool(
    'resolve_memory_conflict',
    {
      description: `Resolve or dismiss an open contradiction between two durable memories. Use the exact conflict id, preserve the historical memories, and provide observable evidence for the resolution.`,
      inputSchema: z.object({
        executionId: z.string().uuid().describe('Active execution authorizing and auditing the resolution.'),
        conflictId: z.string().uuid(),
        outcome: z.enum(['resolved','dismissed']),
        explanation: z.string().min(12),
        evidence: z.array(z.string().min(2)).min(1).max(10)
      })
    },
    async ({ executionId, conflictId, outcome, explanation, evidence }) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const conflict = await client.query(
          `UPDATE memory.memory_conflicts c SET status=$3,resolution=jsonb_build_object('explanation',$4::text,'evidence',$5::jsonb,'executionId',$1::text),resolved_at=now()
            FROM memory.executions x,memory.workspaces w
           WHERE c.id=$2 AND c.status='open' AND x.id=$1 AND x.status='active'
             AND w.id=c.workspace_id AND w.domain_id=x.domain_id
          RETURNING c.id,c.memory_a_id,c.memory_b_id,c.conflict_type,c.status,c.resolution,c.resolved_at`,
          [executionId, conflictId, outcome, explanation, JSON.stringify(evidence)]
        );
        if (!conflict.rows[0]) throw new Error('Open conflict not found in the active execution domain.');
        const event = await addProtocolEvent(client, executionId, 'CorrectionMade', 'Memory conflict resolved', explanation, 'Memory', { conflictId, outcome, evidence });
        await client.query('COMMIT');
        return jsonResult({ conflict: conflict.rows[0], event });
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
  );

  server.registerTool(
    'record_reflection',
    {
      description: `Record execution learning separately from durable facts. Use near the end of an execution to capture what worked, what failed, assumptions and reusable lessons. Reflections are never returned by search_memory and never become facts unless a later complete_execution explicitly consolidates validated knowledge.`,
      inputSchema: z.object({
        executionId: z.string().uuid(),
        whatWorked: z.array(z.string().min(2)).default([]).describe('Approaches that produced observable positive results.'),
        whatFailed: z.array(z.string().min(2)).default([]).describe('Attempts that failed or created avoidable cost, including evidence when known.'),
        assumptions: z.array(z.string().min(2)).default([]).describe('Unverified assumptions that future executions should re-check.'),
        lessonsLearned: z.array(z.string().min(2)).default([]).describe('Reusable process lessons, not product facts.'),
        suggestedImprovements: z.array(z.string().min(2)).default([]).describe('Concrete improvements for future execution behavior.'),
        confidence: z.number().min(0).max(1).optional()
      })
    },
    async ({ executionId, whatWorked, whatFailed, assumptions, lessonsLearned, suggestedImprovements, confidence }) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `INSERT INTO memory.reflections
             (execution_id, what_worked, what_failed, assumptions, lessons_learned, suggested_improvements, confidence)
           SELECT id,$2,$3,$4,$5,$6,$7 FROM memory.executions WHERE id=$1 AND status='active'
           RETURNING id, execution_id, what_worked, what_failed, assumptions, lessons_learned, suggested_improvements, confidence, created_at`,
          [executionId, whatWorked, whatFailed, assumptions, lessonsLearned, suggestedImprovements, confidence ?? null]
        );
        if (!result.rows[0]) throw new Error('Active execution not found.');
        const event = await addProtocolEvent(client, executionId, 'ReflectionRecorded', 'Execution reflection recorded', 'Process learning was captured separately from durable memory.', 'Agent', { reflectionId: result.rows[0].id }, confidence);
        await client.query('COMMIT');
        return jsonResult({ reflection: result.rows[0], event, durableMemoryChanged: false });
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
  );

  server.registerTool(
    'search_reflections',
    {
      description: `Search prior execution reflections for process learning. Reflections are not durable facts: use them as hypotheses for improving the current execution, and consolidate only knowledge that this execution independently validates.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        executionId: z.string().uuid().describe('Active execution whose workspace and domain define the authorized search boundary.'),
        query: z.string().min(1).describe('Focused process problem or lesson to recall.'),
        scope: z.enum(['Workspace','Domain']).default('Workspace'),
        limit: z.number().int().min(1).max(50).default(10)
      })
    },
    async ({ executionId, query, scope, limit }) => {
      const result = await pool.query(
        `WITH context AS (
           SELECT workspace_id,domain_id FROM memory.executions WHERE id=$1 AND status='active'
         )
         SELECT r.id,r.execution_id,r.what_worked,r.what_failed,r.assumptions,r.lessons_learned,
                r.suggested_improvements,r.confidence,r.created_at,w.workspace_key,
                similarity(unaccent(array_to_string(r.lessons_learned || r.what_failed || r.what_worked,' ')),unaccent($2)) AS relevance
           FROM memory.reflections r
           JOIN memory.executions x ON x.id=r.execution_id
           JOIN memory.workspaces w ON w.id=x.workspace_id
           JOIN context c ON (($3='Workspace' AND x.workspace_id=c.workspace_id) OR ($3='Domain' AND x.domain_id=c.domain_id))
          WHERE similarity(unaccent(array_to_string(r.lessons_learned || r.what_failed || r.what_worked,' ')),unaccent($2)) > .05
          ORDER BY relevance DESC,r.created_at DESC LIMIT $4`,
        [executionId, query, scope, limit]
      );
      return jsonResult({ results: result.rows, instruction: 'Treat reflections as process hypotheses. Validate them in the current execution before creating durable memory.' });
    }
  );

  const memoryChangeSchema = z.object({
    changeType: z.enum(['Created', 'Updated', 'Archived', 'Invalidated']).describe('Lifecycle operation applied to durable memory.'),
    memoryId: z.string().uuid().optional().describe('Required for Updated, Archived or Invalidated; omit for Created.'),
    memoryType: z.enum(['fact','decision','preference','procedure','entity','task','artifact','hypothesis','question']).optional().describe('Required when changeType is Created.'),
    title: z.string().min(2).optional().describe('Required for Created; optional replacement title for Updated.'),
    summary: z.string().min(2).optional().describe('Required for Created; concise durable statement understandable without logs.'),
    story: z.record(z.string(), z.unknown()).default({}).describe('Human causal context such as phase, context, problem, decision, reason, result, evidence and consequence.'),
    content: z.record(z.string(), z.unknown()).default({}).describe('Optional structured domain data. Do not store chain-of-thought.'),
    confidence: z.number().min(0).max(1).default(0.7),
    importance: z.number().min(0).max(1).default(0.5),
    contentHash: z.string().min(1).optional().describe('Stable idempotency hash for Created memory.'),
    validatedFromReflectionId: z.string().uuid().optional().describe('For Created memory only: prior reflection validated by this execution. It must belong to the same knowledge domain.'),
    reason: z.string().min(2).optional().describe('Required for Archived or Invalidated; recommended for Updated.')
  });

  server.registerTool(
    'complete_execution',
    {
      description: `Finish an execution once. Store final status, duration, user-facing response, confidence and explicit durable memory changes. Only validated, reusable outcomes belong in memoryChanges. Do not copy the transcript, tool chatter, raw reflection or private reasoning into durable memory.`,
      inputSchema: z.object({
        executionId: z.string().uuid(),
        status: z.enum(['completed','failed','cancelled']),
        durationMs: z.number().int().min(0).describe('Total wall-clock execution duration in milliseconds.'),
        finalResponse: z.string().min(1).describe('Final user-facing answer or concise failure outcome.'),
        confidence: z.number().min(0).max(1).describe('Confidence that the requested outcome was correctly achieved.'),
        memoryChanges: z.array(memoryChangeSchema).max(50).default([]).describe('Explicit durable facts, decisions or lifecycle changes produced by this execution. Use an empty array when nothing reusable changed.')
      })
    },
    async ({ executionId, status, durationMs, finalResponse, confidence, memoryChanges }) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const execution = await client.query<{ workspace_id: string; session_id: string; agent_id: string; domain_id: string }>(
          `SELECT x.workspace_id,x.session_id,x.agent_id,x.domain_id
             FROM memory.executions x JOIN memory.sessions s ON s.id=x.session_id
            WHERE x.id=$1 AND x.status='active' FOR UPDATE OF x,s`, [executionId]
        );
        if (!execution.rows[0]) throw new Error('Active execution not found or already completed.');
        const changed: unknown[] = [];
        for (const change of memoryChanges) {
          if (change.changeType === 'Created') {
            if (!change.memoryType || !change.title || !change.summary) throw new Error('Created memory requires memoryType, title and summary.');
            if (change.validatedFromReflectionId) {
              const reflection = await client.query(
                `SELECT 1 FROM memory.reflections r JOIN memory.executions source ON source.id=r.execution_id
                  WHERE r.id=$1 AND source.domain_id=$2`,
                [change.validatedFromReflectionId, execution.rows[0].domain_id]
              );
              if (!reflection.rows[0]) throw new Error('validatedFromReflectionId was not found in the execution domain.');
            }
            const event = await addProtocolEvent(client, executionId, 'MemoryConsolidated', change.title, change.summary, 'Memory', {
              memoryType: change.memoryType,
              validatedFromReflectionId: change.validatedFromReflectionId ?? null
            }, change.confidence);
            const embedding = await createEmbedding(`${change.title}\n${change.summary}`);
            const node = await client.query(
              `INSERT INTO memory.memory_nodes
                 (workspace_id,source_session_id,source_execution_event_id,node_type,title,summary,content,confidence,importance,content_hash,embedding)
               VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::vector)
               ON CONFLICT (workspace_id,content_hash) DO UPDATE SET confidence=GREATEST(memory.memory_nodes.confidence,EXCLUDED.confidence),
                 importance=GREATEST(memory.memory_nodes.importance,EXCLUDED.importance),
                 embedding=COALESCE(EXCLUDED.embedding,memory.memory_nodes.embedding),updated_at=now()
               RETURNING id,node_type,title,summary,status`,
              [execution.rows[0].workspace_id, execution.rows[0].session_id, event.id, change.memoryType, change.title, change.summary, JSON.stringify({ ...change.content, ...change.story, ...(change.validatedFromReflectionId ? { validatedFromReflectionId: change.validatedFromReflectionId } : {}) }), change.confidence, change.importance, change.contentHash ?? null, vectorParameter(embedding)]
            );
            await client.query(`UPDATE memory.execution_events SET metadata=metadata || jsonb_build_object('memoryId',$2::text) WHERE id=$1`, [event.id, node.rows[0].id]);
            changed.push({ changeType: 'Created', ...node.rows[0] });
          } else {
            if (!change.memoryId) throw new Error(`${change.changeType} memory requires memoryId.`);
            if ((change.changeType === 'Archived' || change.changeType === 'Invalidated') && !change.reason) throw new Error(`${change.changeType} memory requires reason.`);
            const newStatus = change.changeType === 'Archived' ? 'archived' : change.changeType === 'Invalidated' ? 'invalidated' : null;
            const node = await client.query(
              `UPDATE memory.memory_nodes SET
                 status=COALESCE($3,status), title=COALESCE($4,title), summary=COALESCE($5,summary),
                 content=content || $6::jsonb || CASE WHEN $7::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('changeReason',$7::text,'changedAt',now()) END,
                 confidence=GREATEST(confidence,$8), importance=GREATEST(importance,$9)
               WHERE id=$1 AND workspace_id=$2 RETURNING id,node_type,title,summary,status`,
              [change.memoryId, execution.rows[0].workspace_id, newStatus, change.title ?? null, change.summary ?? null, JSON.stringify({ ...change.content, ...change.story }), change.reason ?? null, change.confidence, change.importance]
            );
            if (!node.rows[0]) throw new Error(`Memory ${change.memoryId} not found in execution workspace.`);
            if (change.changeType === 'Updated' && (change.title || change.summary)) {
              const embedding = await createEmbedding(`${node.rows[0].title}\n${node.rows[0].summary}`);
              if (embedding) await client.query('UPDATE memory.memory_nodes SET embedding=$2::vector WHERE id=$1', [node.rows[0].id, vectorParameter(embedding)]);
            }
            changed.push({ changeType: change.changeType, ...node.rows[0] });
          }
        }
        await addProtocolEvent(client, executionId, 'ExecutionCompleted', 'Execution completed', finalResponse, 'System', { status, durationMs, memoryChangeCount: changed.length }, confidence);
        await client.query(
          `UPDATE memory.executions SET status=$2,completed_at=now(),duration_ms=$3,final_response=$4,confidence=$5,memory_changes=$6::jsonb WHERE id=$1`,
          [executionId, status, durationMs, finalResponse, confidence, JSON.stringify(changed)]
        );
        await finishSessionIfIdle(client, execution.rows[0].session_id);
        await client.query('COMMIT');
        return jsonResult({ executionId, status, durationMs, confidence, memoryChanges: changed });
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
  );

  return server;
}

const handler = createMcpHandler(createServer);
const app = createMcpExpressApp({
  host: '0.0.0.0',
  allowedHosts: ['localhost', '127.0.0.1', 'mcp'],
  jsonLimit: '100mb'
});
app.use(performanceMiddleware);
const nodeHandler = toNodeHandler(handler);

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

app.get('/api/live', (_req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);
  const unsubscribe = subscribeToProtocolEvents(event => {
    res.write(`event: memory-event\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

app.get('/api/performance', (_req, res) => res.json(performanceSummary()));

app.get('/api/search-results/:eventId', async (req, res) => {
  try {
    const event = await pool.query(
      `SELECT pe.description,pe.metadata,x.language,w.id AS workspace_id,w.domain_id
         FROM memory.execution_events pe
         JOIN memory.executions x ON x.id=pe.execution_id
         JOIN memory.workspaces w ON w.id=x.workspace_id
        WHERE pe.id=$1 AND pe.event_type='MemorySearched'`,
      [req.params.eventId]
    );
    if (!event.rows[0]) return res.status(404).json({ error: 'Memory search event not found.' });
    const source = event.rows[0];
    const count = Math.min(50, Math.max(0, Number(source.metadata?.resultCount ?? 0)));
    if (!count) return res.json({ results: [] });
    await pool.query(`SET pg_trgm.similarity_threshold = '0.15'`);
    const results = await pool.query(
      `SELECT n.id,n.title,n.summary,
              ts_rank_cd(n.search_document,plainto_tsquery('simple',$1))
                + similarity(lower(n.title),lower($1)) AS relevance
         FROM memory.memory_nodes n
         JOIN memory.workspaces w ON w.id=n.workspace_id
        WHERE n.status='active'
          AND (($2='Domain' AND w.domain_id=$4) OR ($2<>'Domain' AND w.id=$3))
          AND (n.search_document @@ plainto_tsquery('simple',$1) OR lower(n.title) % lower($1))
        ORDER BY relevance DESC,n.importance DESC,n.created_at DESC LIMIT $5`,
      [source.description, source.metadata?.scope ?? 'Workspace', source.workspace_id, source.domain_id, count]
    );
    res.json({
      results: results.rows.map(memory => ({
        id: memory.id,
        title: memory.title,
        summary: memory.summary,
        lexicalRelevance: Number(memory.relevance ?? 0),
        semanticRelevance: 0,
        relevance: Number(memory.relevance ?? 0)
      })),
      reconstructed: true
    });
  } catch (error) {
    console.error('Historical search reconstruction failed', error);
    res.status(500).json({ error: 'Unable to reconstruct historical search results.' });
  }
});

app.get('/api/explorer', async (req, res) => {
  const workspaceKey = typeof req.query.workspace === 'string' && req.query.workspace.trim()
    ? req.query.workspace.trim()
    : null;

  try {
    const [workspaces, events, nodes, relations, conflicts, graphStatus] = await Promise.all([
      pool.query(
        `SELECT w.id, w.domain_id, d.domain_key, d.name AS domain_name,
                w.workspace_key, w.display_name, w.description, w.tags, w.created_at,
                 count(DISTINCT s.id)::int AS session_count,
                 count(DISTINCT n.id)::int AS memory_count
           FROM memory.workspaces w
           LEFT JOIN memory.knowledge_domains d ON d.id=w.domain_id
           LEFT JOIN memory.sessions s ON s.workspace_id = w.id
           LEFT JOIN memory.memory_nodes n ON n.workspace_id = w.id
          GROUP BY w.id,d.id
          ORDER BY w.created_at DESC`
      ),
      pool.query(
        `SELECT e.id, e.sequence, e.event_type, e.payload, e.occurred_at,
                w.workspace_key, w.domain_id, d.domain_key, s.id AS session_id, s.task, s.status AS session_status,
                COALESCE(a.agent_key, session_agent.agent_key, 'agent_default') AS agent_key
           FROM memory.memory_events e
           JOIN memory.workspaces w ON w.id = e.workspace_id
           LEFT JOIN memory.knowledge_domains d ON d.id=w.domain_id
           LEFT JOIN memory.sessions s ON s.id = e.session_id
           LEFT JOIN memory.agents a ON a.id = e.agent_id
           LEFT JOIN memory.agents session_agent ON session_agent.id = s.agent_id
          WHERE ($1::text IS NULL OR w.workspace_key = $1)
            AND NOT EXISTS (
                SELECT 1 FROM memory.execution_events pe
                 WHERE pe.metadata->>'legacyEventId'=e.id::text
            )
          ORDER BY e.sequence DESC`,
        [workspaceKey]
      ),
      pool.query(
        `SELECT n.id, n.node_type, n.title, n.summary, n.content, n.status,
                n.confidence, n.importance, n.valid_from, n.valid_until,
                n.created_at, n.updated_at, n.source_event_id, n.source_execution_event_id, n.source_session_id,
                 w.workspace_key, w.domain_id, d.domain_key, COALESCE(a.agent_key, 'agent_default') AS agent_key
           FROM memory.memory_nodes n
           JOIN memory.workspaces w ON w.id = n.workspace_id
           LEFT JOIN memory.knowledge_domains d ON d.id=w.domain_id
           LEFT JOIN memory.sessions s ON s.id = n.source_session_id
           LEFT JOIN memory.agents a ON a.id = s.agent_id
          WHERE ($1::text IS NULL OR w.workspace_key = $1)
          ORDER BY n.importance DESC, n.created_at DESC`,
        [workspaceKey]
      ),
      pool.query(
        `SELECT r.id, r.source_id, r.target_id, r.relation_type, r.weight,
                r.confidence, r.metadata, r.created_at, w.workspace_key,
                source_workspace.workspace_key AS source_workspace_key,
                target_workspace.workspace_key AS target_workspace_key,
                source_domain.domain_key,
                COALESCE(source_agent.agent_key, 'agent_default') AS source_agent_key,
                COALESCE(target_agent.agent_key, 'agent_default') AS target_agent_key
           FROM memory.memory_relations r
           JOIN memory.workspaces w ON w.id = r.workspace_id
           JOIN memory.memory_nodes source_node ON source_node.id = r.source_id
           JOIN memory.memory_nodes target_node ON target_node.id = r.target_id
           JOIN memory.workspaces source_workspace ON source_workspace.id=source_node.workspace_id
           JOIN memory.workspaces target_workspace ON target_workspace.id=target_node.workspace_id
           LEFT JOIN memory.knowledge_domains source_domain ON source_domain.id=source_workspace.domain_id
           LEFT JOIN memory.sessions source_session ON source_session.id = source_node.source_session_id
           LEFT JOIN memory.sessions target_session ON target_session.id = target_node.source_session_id
           LEFT JOIN memory.agents source_agent ON source_agent.id = source_session.agent_id
           LEFT JOIN memory.agents target_agent ON target_agent.id = target_session.agent_id
          WHERE ($1::text IS NULL OR w.workspace_key = $1)
          ORDER BY r.created_at DESC`,
        [workspaceKey]
      ),
      pool.query(
        `SELECT c.id, c.memory_a_id, c.memory_b_id, c.conflict_type,
                c.status, c.resolution, c.created_at, c.resolved_at, w.workspace_key
           FROM memory.memory_conflicts c
           JOIN memory.workspaces w ON w.id = c.workspace_id
          WHERE ($1::text IS NULL OR w.workspace_key = $1)
          ORDER BY c.created_at DESC`,
        [workspaceKey]
      ),
      pool.query('SELECT node_count, edge_count, sync_status, needs_rebuild, schema_status FROM graph.status()')
    ]);

    const [domains, executions, protocolEvents, reflections, authoritativeGraph] = await Promise.all([
      pool.query(
        `SELECT d.id,d.domain_key,d.name,d.description,d.tags,d.metadata,d.created_at,d.updated_at,
                count(DISTINCT w.id)::int AS workspace_count,
                count(DISTINCT x.id)::int AS execution_count
           FROM memory.knowledge_domains d
           LEFT JOIN memory.workspaces w ON w.domain_id=d.id
           LEFT JOIN memory.executions x ON x.domain_id=d.id
          GROUP BY d.id ORDER BY d.updated_at DESC`
      ),
      pool.query(
        `SELECT x.id,x.domain_id,d.domain_key,x.workspace_id,w.workspace_key,
                x.session_id,COALESCE(a.agent_key,'agent_default') AS agent_id,x.goal,x.user_request,
                x.expected_outcome,x.language,x.environment,x.model,x.priority,x.status,x.started_at,
                x.completed_at,x.duration_ms,x.final_response,x.confidence,x.memory_changes
           FROM memory.executions x
           JOIN memory.workspaces w ON w.id=x.workspace_id
           LEFT JOIN memory.knowledge_domains d ON d.id=x.domain_id
           LEFT JOIN memory.agents a ON a.id=x.agent_id
          WHERE ($1::text IS NULL OR w.workspace_key=$1)
           ORDER BY x.started_at DESC`, [workspaceKey]
      ),
      pool.query(
        `SELECT pe.id,pe.execution_id,pe.sequence,pe.occurred_at,pe.event_type,pe.title,
                pe.description,pe.source,pe.metadata,pe.confidence,w.workspace_key,d.domain_key,
                x.session_id,x.goal,x.language,x.status AS execution_status,
                COALESCE(a.agent_key,'agent_default') AS agent_id
           FROM memory.execution_events pe
           JOIN memory.executions x ON x.id=pe.execution_id
           JOIN memory.workspaces w ON w.id=x.workspace_id
           LEFT JOIN memory.knowledge_domains d ON d.id=x.domain_id
           LEFT JOIN memory.agents a ON a.id=x.agent_id
          WHERE ($1::text IS NULL OR w.workspace_key=$1)
           ORDER BY pe.occurred_at DESC,pe.sequence DESC`, [workspaceKey]
      ),
      pool.query(
        `SELECT r.id,r.execution_id,r.what_worked,r.what_failed,r.assumptions,r.lessons_learned,
                r.suggested_improvements,r.confidence,r.created_at,w.workspace_key,d.domain_key
           FROM memory.reflections r
           JOIN memory.executions x ON x.id=r.execution_id
           JOIN memory.workspaces w ON w.id=x.workspace_id
           LEFT JOIN memory.knowledge_domains d ON d.id=x.domain_id
          WHERE ($1::text IS NULL OR w.workspace_key=$1)
           ORDER BY r.created_at DESC`, [workspaceKey]
      ),
      pool.query(
        `SELECT count(DISTINCT n.id)::int AS node_count,
                count(DISTINCT r.id)::int AS edge_count
           FROM memory.memory_nodes n
           JOIN memory.workspaces w ON w.id=n.workspace_id
           LEFT JOIN memory.memory_relations r ON r.workspace_id=w.id
          WHERE n.status='active' AND ($1::text IS NULL OR w.workspace_key=$1)`, [workspaceKey]
      )
    ]);

    const enrichedProtocolEvents = protocolEvents.rows;

    const normalizedProtocolEvents = enrichedProtocolEvents.map(event => ({
      id: `protocol:${event.id}`,
      protocol_event_id: event.id,
      execution_id: event.execution_id,
      sequence: Date.parse(event.occurred_at) * 1000 + Number(event.sequence),
      event_type: event.event_type,
      payload: {
        title: event.title,
        summary: event.description,
        source: event.source,
        confidence: event.confidence,
        ...event.metadata
      },
      occurred_at: event.occurred_at,
      workspace_key: event.workspace_key,
      domain_key: event.domain_key,
      session_id: event.session_id,
      task: event.goal,
      session_status: event.execution_status,
      agent_key: event.agent_id
    }));

    res.json({
      generatedAt: new Date().toISOString(),
      filter: { workspace: workspaceKey },
      domains: domains.rows,
      workspaces: workspaces.rows,
      executions: executions.rows,
      protocolEvents: enrichedProtocolEvents,
      reflections: reflections.rows,
      events: [...events.rows, ...normalizedProtocolEvents].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)),
      memories: nodes.rows,
      relations: relations.rows,
      conflicts: conflicts.rows,
      graph: {
        ...(graphStatus.rows[0] ?? {}),
        node_count: authoritativeGraph.rows[0]?.node_count ?? 0,
        edge_count: authoritativeGraph.rows[0]?.edge_count ?? 0,
        count_source: 'authoritative_tables'
      }
    });
  } catch (error) {
    console.error('Explorer API failed', error);
    res.status(500).json({ error: 'Unable to load memory explorer data.' });
  }
});
registerEmbeddingSettingsRoutes(app);
registerBackupRoutes(app);
app.all('/mcp', (req, res) => void nodeHandler(req, res, req.body));

const port = Number.parseInt(process.env.PORT ?? '3333', 10);
app.listen(port, '0.0.0.0', () => {
  console.error(`LinearMemory MCP listening on :${port}/mcp`);
});

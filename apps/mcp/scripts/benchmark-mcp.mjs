import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const endpoint = process.env.MCP_BENCHMARK_URL ?? 'http://127.0.0.1:3333/mcp';
const eventIterations = Number(argument('event-iterations') ?? 50);
const searchIterations = Number(argument('search-iterations') ?? 30);
const pool = new pg.Pool();

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
}

function summarize(values) {
  return {
    samples: values.length,
    averageMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
    p50Ms: percentile(values, .5),
    p95Ms: percentile(values, .95),
    p99Ms: percentile(values, .99),
    minMs: Number(Math.min(...values).toFixed(2)),
    maxMs: Number(Math.max(...values).toFixed(2))
  };
}

async function callTool(name, args) {
  const startedAt = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}: ${body}`);
  const dataLine = body.split('\n').find(line => line.startsWith('data: '));
  if (!dataLine) throw new Error(`${name} returned an unexpected response.`);
  const payload = JSON.parse(dataLine.slice(6));
  if (payload.error || payload.result?.isError) throw new Error(`${name} failed: ${JSON.stringify(payload.error ?? payload.result)}`);
  return { durationMs: performance.now() - startedAt, result: payload.result?.structuredContent };
}

const selected = await pool.query(
  `SELECT w.id AS workspace_id,w.domain_id
     FROM memory.workspaces w
     JOIN memory.memory_nodes n ON n.workspace_id=w.id AND n.status='active'
    GROUP BY w.id ORDER BY count(*) DESC LIMIT 1`
);
if (!selected.rows[0]) throw new Error('The benchmark needs at least one workspace containing active memories.');

const executionId = randomUUID();
let sessionId;
try {
  const begin = await callTool('begin_context', {
    agentId: 'performance_benchmark',
    domainId: selected.rows[0].domain_id,
    workspaceId: selected.rows[0].workspace_id,
    executionId,
    goal: 'Measure LinearMemory MCP ingestion and search latency.',
    userRequest: 'Automated non-destructive performance benchmark.',
    expectedOutcome: 'Latency percentiles for event ingestion and memory search.',
    language: 'en-US',
    environment: 'performance-test',
    priority: 'normal',
    metadata: { benchmark: true }
  });
  sessionId = begin.result.execution.session_id;

  const ingestion = [];
  for (let index = 0; index < eventIterations; index += 1) {
    const sample = await callTool('add_execution_event', {
      executionId,
      eventType: 'ProgressUpdated',
      title: `Benchmark event ${index + 1}`,
      description: 'Synthetic event used only for latency measurement.',
      source: 'System',
      metadata: { benchmark: true, index }
    });
    ingestion.push(sample.durationMs);
  }

  const search = [];
  const queries = ['architecture decision', 'memory search', 'error correction', 'validated procedure'];
  for (let index = 0; index < searchIterations; index += 1) {
    const sample = await callTool('search_memory', {
      executionId,
      query: queries[index % queries.length],
      scope: 'Domain',
      memoryTypes: [],
      limit: 10
    });
    search.push(sample.durationMs);
  }

  console.log(JSON.stringify({
    endpoint,
    generatedAt: new Date().toISOString(),
    ingestion: summarize(ingestion),
    search: summarize(search)
  }, null, 2));
} finally {
  await pool.query('DELETE FROM memory.execution_events WHERE execution_id=$1', [executionId]);
  await pool.query('DELETE FROM memory.reflections WHERE execution_id=$1', [executionId]);
  await pool.query('DELETE FROM memory.executions WHERE id=$1', [executionId]);
  if (sessionId) await pool.query('DELETE FROM memory.sessions WHERE id=$1', [sessionId]);
  await pool.query(`DELETE FROM memory.agents a WHERE a.agent_key='performance_benchmark' AND NOT EXISTS (SELECT 1 FROM memory.sessions s WHERE s.agent_id=a.id) AND NOT EXISTS (SELECT 1 FROM memory.executions x WHERE x.agent_id=a.id)`);
  await pool.end();
}

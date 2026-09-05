import type { NextFunction, Request, Response } from 'express';

type PerformanceCategory = 'ingestion' | 'query' | 'other';

export type PerformanceEntry = {
  operation: string;
  category: PerformanceCategory;
  durationMs: number;
  statusCode: number;
  timestamp: string;
};

const entries: PerformanceEntry[] = [];
const maximumEntries = Math.max(100, Number.parseInt(process.env.PERFORMANCE_LOG_CAPACITY ?? '2000', 10));
const slowRequestMs = Math.max(1, Number.parseInt(process.env.PERFORMANCE_SLOW_REQUEST_MS ?? '250', 10));

const queryTools = new Set(['find_domain', 'find_workspace', 'suggest_workspace', 'search_memory', 'find_memory_relations']);
const ingestionTools = new Set([
  'create_domain', 'update_domain', 'create_workspace', 'update_workspace', 'begin_context',
  'add_execution_event', 'link_memories', 'unlink_memories', 'reflection', 'complete_execution'
]);

function categoryFor(operation: string): PerformanceCategory {
  if (queryTools.has(operation)) return 'query';
  if (ingestionTools.has(operation)) return 'ingestion';
  return 'other';
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function recordPerformance(entry: PerformanceEntry): void {
  entries.push(entry);
  if (entries.length > maximumEntries) entries.splice(0, entries.length - maximumEntries);
  console.error(JSON.stringify({
    level: entry.durationMs >= slowRequestMs ? 'warn' : 'info',
    type: 'performance',
    ...entry,
    slow: entry.durationMs >= slowRequestMs
  }));
}

export function performanceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = performance.now();
  res.once('finish', () => {
    const toolName = req.path === '/mcp' && req.body?.method === 'tools/call'
      ? String(req.body?.params?.name ?? 'unknown_tool')
      : `${req.method} ${req.path}`;
    recordPerformance({
      operation: toolName,
      category: categoryFor(toolName),
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      statusCode: res.statusCode,
      timestamp: new Date().toISOString()
    });
  });
  next();
}

export function performanceSummary() {
  const grouped = new Map<string, PerformanceEntry[]>();
  for (const entry of entries) {
    const current = grouped.get(entry.operation) ?? [];
    current.push(entry);
    grouped.set(entry.operation, current);
  }
  return {
    retainedSamples: entries.length,
    capacity: maximumEntries,
    slowRequestMs,
    operations: [...grouped.entries()].map(([operation, samples]) => {
      const durations = samples.map(sample => sample.durationMs);
      return {
        operation,
        category: samples[0].category,
        count: samples.length,
        errors: samples.filter(sample => sample.statusCode >= 400).length,
        averageMs: Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(2)),
        p50Ms: percentile(durations, .5),
        p95Ms: percentile(durations, .95),
        p99Ms: percentile(durations, .99),
        maximumMs: Math.max(...durations)
      };
    }).sort((left, right) => right.p95Ms - left.p95Ms)
  };
}

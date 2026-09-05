import assert from 'node:assert/strict';
import test from 'node:test';
import { performanceSummary, recordPerformance } from '../src/performance.js';

test('performance telemetry aggregates operation latency and errors', () => {
  recordPerformance({ operation: 'test_operation', category: 'query', durationMs: 10, statusCode: 200, timestamp: new Date().toISOString() });
  recordPerformance({ operation: 'test_operation', category: 'query', durationMs: 30, statusCode: 500, timestamp: new Date().toISOString() });
  const operation = performanceSummary().operations.find(item => item.operation === 'test_operation');
  assert.deepEqual(operation, {
    operation: 'test_operation', category: 'query', count: 2, errors: 1,
    averageMs: 20, p50Ms: 10, p95Ms: 30, p99Ms: 30, maximumMs: 30
  });
});

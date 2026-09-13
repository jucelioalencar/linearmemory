# MCP load testing with a 100x snapshot

The fixture and HTTP load runner only accept an isolated database whose name ends in `_perf`, with `PERF_ISOLATED=yes`. Never point them at the application database. Reports contain timings, not memory contents. Keep the database dump outside the repository.

## Reproducing the test

1. Use `pg_dump -Fc --schema=memory --exclude-table-data=memory.system_settings` to take a consistent snapshot. This excludes provider credentials and endpoints.
2. Start a separate PostgreSQL container using the same extensions as production, a separate volume, and a loopback-only port. Restore the dump into an empty `memory` schema using `pg_restore --no-owner --exit-on-error`. Ensure `unaccent`, `pg_trgm`, `vector`, `pg_cron` and `graph` are installed.
3. Set standard `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` variables to the isolated database. Set `PERF_ISOLATED=yes` and run `node scripts/scale-performance-fixture.mjs` from `apps/mcp`. `PERF_SCALE` defaults to 100. The script refuses a second scaling pass and runs transactionally.
4. Run the old API with `PERF_API_ENTRY` pointing to its entry file in an isolated checkout, then apply migrations and run the changed API. The checkout needs its dependencies installed. Do not run before/after loads simultaneously.
5. Run `node scripts/load-tools.mjs`. Set `PERF_CONCURRENCY=5`, `PERF_ITERATIONS=20`, `PERF_MODE=lexical` or `semantic`, and `PERF_REPORT` to the desired report file. The runner starts and stops its own API on port 3349 (`PERF_PORT` overrides it).

The fixture multiplies sessions, executions, both event tables, memories, relationships, conflicts and reflections. Agents, domains and workspaces are retained so the existing scopes become dense. IDs and structured references are remapped; title/summary distribution and existing vectors are duplicated. This models volume growth, not 100x more distinct subjects or tenants. Fixture generation is SQL setup time, excluded from HTTP ingestion measurements.

Each workflow exercises all 17 tools, including catalog creation/update, discovery, event ingestion, memory consolidation, reflection lookup, linking, conflict resolution and unlinking. Twenty workflows produce 380 measured HTTP calls. Reported throughput belongs to this mixed closed-loop workload, not a maximum standalone ingestion rate. P99 from twenty samples is effectively the maximum and should not be treated as a stable production percentile.

Semantic mode uses a deterministic local HTTP provider returning an existing vector, with the query cache disabled. It measures API and vector SQL cost, excluding model inference, external network latency, and semantic retrieval quality. No copied credentials are used. The runner generates small additional records in the isolated database; recreate the fixture for byte-identical reruns.

## Implementation

- Relationship discovery uses three GiST nearest-neighbor candidate sets (title, summary and combined text), then deduplicates and applies the original similarity threshold and ranking. Each branch keeps the requested top-k with the same secondary ordering; the final maximum similarity cannot introduce a better candidate outside all three sets.
- Reflection text is normalized at write time and indexed. Its trigger updates it when reflection fields change.
- Memory search computes scores once and joins result content and agent details after selecting the requested result count.

Migration `005-indexed-discovery.sql` creates indexes and backfills reflection search text. Index creation needs disk space and can delay writes during migration; schedule deployment accordingly for a larger production database. The extra indexes also add write/storage cost, which the mixed load measures.

## Measured results (September 12–13, 2026)

The source snapshot contained 883 memories (882 vectors), 1,907 execution events, 142 executions and 127 reflections. The isolated 100x fixture contained 88,300 memories (88,200 vectors), 190,700 execution events, 14,200 executions and 12,700 reflections, retaining the original nine workspaces and one domain. Its initial size was approximately 1.58 GB before the new indexes. Source records were not modified.

Windows host, local Node 22.20.0, PostgreSQL 17 in Docker. Existing local application containers remained running. Baseline API revision: `ac86282`. Each comparable run used five concurrent workflows, 20 workflows total and 380 HTTP tool calls. All 17 advertised tools were covered, with zero failed workflows or tool errors in these four runs.

| Scenario | Before, calls/s | After, calls/s | Improvement |
| --- | ---: | ---: | ---: |
| Text search mixed workload | 3.49 | 10.12 | 2.90x |
| Deterministic-vector mixed workload | 2.86 | 11.52 | 4.03x |

P95 request latency, milliseconds:

| Tool | Text before | Text after | Vector before | Vector after |
| --- | ---: | ---: | ---: | ---: |
| search_memory | 2,363 | 7,969 | 15,555 | 4,556 |
| find_memory_relations | 37,750 | 11,059 | 47,367 | 479 |
| search_reflections | 5,502 | 2,784 | 6,524 | 2,657 |
| complete_execution | 402 | 166 | 117 | 298 |

These are individual exploratory runs, not repeated statistical estimates. Cache state was not reset between runs; the first optimized text run contains substantial early spikes. Not every percentile improved: text search P95 increased, and vector-mode completion P95 increased. The observed overall gain does not establish a latency SLA or justify claiming every tool became faster. The runner uses fixed search texts and duplicated vectors, so query diversity and real Ollama/OpenAI inference remain separate tests. The lexical baseline predates a fixture UUID-format correction; contents and counts were preserved, but the fixtures are not byte-identical.

Raw timing reports in `performance/` include all tools, samples, errors and percentiles, without source text or credentials. Regression tests compare actual relation candidate SQL with exhaustive ranking across both scopes, four thresholds and four limits, and verify reflection search-text synchronization and transaction-local threshold cleanup.

### Higher-concurrency check

A subsequent text-mode repeat with warm database caches completed another 380 calls without errors in 25.73 s (14.77 calls/s). P95 was 1.74 s for memory search, 598 ms for relations and 3.45 s for reflections. This supports cache sensitivity as a contributor to the first run's spikes, but is not a controlled cold-cache comparison. Both reports are retained.

Ten concurrent workflows, 50 workflows and 950 calls completed in 75.16 seconds (12.64 calls/s), with zero errors and all 17 tools covered. P95: memory search 10.83 s, relation discovery 705 ms, reflection search 5.24 s, completion 427 ms. This demonstrates successful completion at the tested load, not unlimited scaling: doubling concurrency raised throughput only modestly and increased search latency. Vector scanning and reflection ranking remain optimization targets; bounded concurrency is preferable to unbounded requests. Approximate-vector indexes would require separate recall/quality validation before replacing the current exhaustive semantic ranking.

Validation: TypeScript check passed; 13 integration tests passed using a fresh PostgreSQL Testcontainer and migration 005. Instrumented test-module coverage: 79.14% lines, 68.25% branches, 73.56% functions. These percentages are not a claim of full HTTP-server coverage; the separate load runner exercised all advertised tools over HTTP.

The isolated load-test container was stopped after measurement, preserving its fixture for reuse. No production migration, application deployment, commit or push was performed as part of this benchmark.

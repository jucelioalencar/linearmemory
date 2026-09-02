<div align="center">
  <img src="ico.png" alt="LinearMemory logo" width="112" />
  <h1>LinearMemory</h1>
  <p><strong>Agentic Knowledge Explorer</strong></p>
  <p>Durable, observable, and human-readable memory for AI agents.</p>

  <p>
    <a href="https://github.com/jucelioalencar/linearmemory/actions/workflows/release.yml"><img alt="Build and release" src="https://github.com/jucelioalencar/linearmemory/actions/workflows/release.yml/badge.svg?branch=main"></a>
    <a href="https://github.com/jucelioalencar/linearmemory/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/jucelioalencar/linearmemory"></a>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-MIT-7cdd87.svg"></a>
    <img alt="MCP" src="https://img.shields.io/badge/MCP-Streamable_HTTP-7c3aed">
    <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white">
    <img alt="Docker" src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white">
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white">
  </p>
</div>

## LinearMemory in action

Explore agent histories, consolidated knowledge, execution replays, and cross-agent relationships in the interactive web interface.

<p align="center">
  <img src="demo/video.gif" alt="LinearMemory Agentic Knowledge Explorer interactive demo" width="90%" />
</p>

## Make agent memory understandable

LinearMemory is a persistent memory system for AI agents. It records observable execution events, consolidates validated knowledge, and connects related memories without turning an agent's internal reasoning into an opaque transcript.

Agents access memory through a self-describing MCP server. Humans explore the same knowledge as a chronological story, a relationship map, or an interactive 3D graph.

### Key features

- **Human-readable history** — follow agent activity as a chronological sequence of small, observable events.
- **Durable knowledge** — consolidate only validated facts, decisions, procedures, artifacts, and outcomes.
- **Multi-agent memory** — keep each agent identifiable while connecting knowledge across agents and workspaces.
- **Explained relationships** — every graph edge has a direction, relation type, evidence, confidence, and human-readable explanation.
- **Interactive 3D explorer** — inspect timelines, replay executions, focus filters, hide event types, and navigate correlations.
- **Knowledge hierarchy** — organize long-lived domains above workspaces, sessions, and individual executions.
- **MCP-native protocol** — tools tell the LLM what to send, when to search, and what must never be persisted.
- **Auditable storage** — PostgreSQL remains authoritative; the pgGraph projection is derived and rebuildable.
- **Local-first deployment** — run the database, MCP server, and web explorer with Docker Compose.

## How it works

```mermaid
flowchart LR
    A[AI agent] -->|MCP tools| B[LinearMemory MCP]
    B --> C[(PostgreSQL 17)]
    C --> D[Durable memories]
    C --> E[Execution events]
    C --> F[Explained relations]
    C -. rebuilds .-> G[pgGraph projection]
    D --> H[Web explorer]
    E --> H
    F --> H
    G --> H
    H --> I[Story · Relations · 3D]
```

LinearMemory separates four kinds of information:

1. **Context** identifies the agent, domain, workspace, session, execution, goal, and original user request.
2. **Events** describe observable actions such as memory reads, tool calls, decisions, errors, and corrections.
3. **Reflections** capture process learning without presenting it as factual knowledge.
4. **Memories** contain validated, reusable knowledge explicitly consolidated when an execution finishes.

## Example use cases

| Use case | What LinearMemory provides |
| --- | --- |
| Long-running coding agents | Decisions, architecture, failures, corrections, and reusable procedures across sessions. |
| Multi-agent systems | Shared domain knowledge with agent identity and explicit cross-agent relationships. |
| Support and operations | Auditable incident histories, evidence, outcomes, and validated runbooks. |
| Research workflows | Traceable hypotheses, sources, conclusions, and links between related findings. |
| Agent evaluation | Observable execution timelines without storing private chain-of-thought. |

## Quick start

### Prerequisites

- Docker Desktop with Docker Compose
- Git
- Ports `3000`, `3333`, and `5432` available, or custom port environment variables

### Windows PowerShell

```powershell
git clone https://github.com/jucelioalencar/linearmemory.git
Set-Location linearmemory

New-Item -ItemType Directory -Force .secrets | Out-Null
'replace-with-a-local-password' | Set-Content -NoNewline .secrets/postgres_password
'postgres:5432:linearmemory:linearmemory:replace-with-a-local-password' |
  Set-Content -NoNewline .secrets/postgres_pgpass

docker compose config
docker compose up --build -d
```

### Linux and macOS

```bash
git clone https://github.com/jucelioalencar/linearmemory.git
cd linearmemory

mkdir -p .secrets
printf '%s' 'replace-with-a-local-password' > .secrets/postgres_password
printf '%s' 'postgres:5432:linearmemory:linearmemory:replace-with-a-local-password' \
  > .secrets/postgres_pgpass

docker compose config
docker compose up --build -d
```

When all containers are healthy, open the explorer at [http://localhost:3000](http://localhost:3000).

| Service | Address | Purpose |
| --- | --- | --- |
| Web explorer | `http://localhost:3000` | Story, relation, and 3D memory exploration |
| MCP server | `http://localhost:3333/mcp` | Streamable HTTP endpoint for agents |
| MCP health | `http://localhost:3333/health` | Service health check |
| PostgreSQL | `localhost:5432` | Authoritative persistence and graph projection |

Ports can be changed with `WEB_PORT`, `MCP_PORT`, and `POSTGRES_PORT`.

## MCP memory protocol

The recommended lifecycle prevents duplicate workspaces and keeps durable memory clean:

```text
find_domain → create_domain (only if needed)
           → find_workspace → suggest_workspace → create_workspace (only if needed)
           → begin_context → search_memory
           → add_execution_event ...
           → find_memory_relations → link_memories (when justified)
           → record_reflection → complete_execution
```

Every tool input is documented in its JSON Schema so an LLM can determine what belongs in each field. If `agentId` is omitted, LinearMemory uses `agent_default`.

### Tools

| Tool | Purpose |
| --- | --- |
| `find_domain` | Find a stable knowledge domain before creating one. |
| `create_domain` | Create a durable domain only when no suitable candidate exists. |
| `find_workspace` | Reuse an existing project or work stream inside a domain. |
| `suggest_workspace` | Propose a normalized workspace without writing data. |
| `create_workspace` | Create a workspace after search and validation. |
| `begin_context` | Start an observable execution with identity, goal, request, and environment. |
| `search_memory` | Retrieve durable facts and decisions relevant to the current work. |
| `add_execution_event` | Append a small, observable event without private reasoning. |
| `find_memory_relations` | Inspect current edges and discover candidate memories without creating relations. |
| `link_memories` | Create or update one explicit, evidence-backed directed relationship. |
| `unlink_memories` | Remove an incorrect or obsolete relationship and record why. |
| `record_reflection` | Store process learning separately from durable facts. |
| `complete_execution` | Finish the execution and apply explicit, validated memory changes. |

### Execution events

`ContextStarted`, `MemorySearched`, `MemoryRead`, `MemoryLinked`, `MemoryUnlinked`, `ToolStarted`, `ToolFinished`, `HypothesisCreated`, `DecisionMade`, `ArtifactCreated`, `ProgressUpdated`, `ErrorOccurred`, `CorrectionMade`, and `UserFeedbackReceived`.

### Memory relationships

`supports`, `depends_on`, `caused`, `contradicts`, `refines`, `implements`, `validates`, `supersedes`, and `related_to`.

> [!IMPORTANT]
> Text similarity is a discovery hint, not a relationship. Before calling `link_memories`, the agent must read both memories and provide direction, explanation, evidence, and confidence.

> [!NOTE]
> Reflections are excluded from `search_memory`. They become durable knowledge only when a later execution validates and explicitly consolidates them.

## Agent templates

The [`agents/`](agents/) directory provides an English `automation-pilot` agent pack for OpenCode, Claude Code, OpenAI Codex, Gemini CLI, Cursor, and generic LLM clients. Every platform variant follows one shared browser-automation and LinearMemory behavior contract, with native metadata for its target client.

See [`agents/README.md`](agents/README.md) for supported formats and installation paths.

## Web explorer

The browser interface presents the same source data through three complementary views:

- **Read story** — a chronological, human-readable memory narrative with date, time, agent, and execution context.
- **Explore relations** — focused cause, dependency, support, validation, and contradiction paths.
- **Explore in 3D** — an interactive multi-agent graph with configurable grouping, elevated correlation waves, local or global relation focus, connection replay, event colors, execution replay, filters, fullscreen mode, keyboard navigation, and contextual tooltips.

The interface defaults to English and supports Spanish and Portuguese. Dark and white themes are available from Settings.

## Architecture

| Component | Technology | Responsibility |
| --- | --- | --- |
| `apps/mcp` | TypeScript, Express, MCP SDK, Zod | Tool schemas, protocol validation, and memory operations |
| `apps/web` | HTML, CSS, JavaScript, Nginx, 3D Force Graph | Human-readable and interactive exploration |
| `docker/postgres` | PostgreSQL 17, pgGraph 1.2.0, pgvector 0.8.6, pg_cron | Authoritative storage, graph projection, and database jobs |
| `compose.yaml` | Docker Compose | One local application network and reproducible startup |

```text
linearmemory/
├── apps/
│   ├── mcp/                 # MCP server and memory protocol
│   └── web/                 # Agentic Knowledge Explorer
├── docker/
│   ├── compose/             # Application and database services
│   └── postgres/            # PostgreSQL image and schema initialization
├── compose.yaml
├── Makefile
└── README.md
```

## Verification and testing

Check that all services are healthy:

```bash
docker compose ps
```

Verify PostgreSQL extensions and the graph projection:

```bash
docker compose exec postgres psql -U linearmemory -d linearmemory \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname IN ('graph', 'vector', 'pg_cron');"

docker compose exec postgres psql -U linearmemory -d linearmemory \
  -c "SELECT * FROM graph.status();"
```

Type-check the MCP server from a development environment:

```bash
cd apps/mcp
npm ci
npm run typecheck
```

Useful Make targets are also available:

```bash
make up
make ps
make logs
make graph-status
make down
```

## Resetting local data

PostgreSQL initialization scripts run only when the database volume is created. To erase all local LinearMemory data and rebuild the stack:

```bash
docker compose down -v --remove-orphans
docker compose up --build -d
```

> [!CAUTION]
> This permanently removes the local `linearmemory-postgres-data` volume and every stored domain, workspace, execution, event, memory, and relationship.

## Contributing

Contributions, bug reports, and design discussions are welcome. Before opening a pull request:

1. Keep memory events observable and free of private chain-of-thought.
2. Preserve PostgreSQL as the source of truth and graph projections as rebuildable views.
3. Add self-describing schemas when changing MCP tools.
4. Run the verification commands above.

Use [GitHub Issues](https://github.com/jucelioalencar/linearmemory/issues) for questions, proposals, and bug reports.

## License

LinearMemory is available under the [MIT License](LICENSE).

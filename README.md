# LinearMemory

Infraestrutura inicial para memória linear persistente, consumida por LLMs via MCP.

## Stack

- PostgreSQL 17 como fonte de verdade.
- pgGraph 1.2.0 para a projeção derivada e travessias do grafo.
- pgvector 0.8.6 para embeddings e busca semântica futura.
- MCP TypeScript SDK v2 servido por Streamable HTTP.
- Interface web provisória em Nginx.

Os arquivos Compose são separados por domínio, mas carregados pelo `compose.yaml` raiz como uma única aplicação Compose e uma única rede.

## Inicialização

Crie os arquivos de segredo locais. A pasta `.secrets` é ignorada pelo Git.

PowerShell:

```powershell
New-Item -ItemType Directory -Force .secrets | Out-Null
'defina-localmente' | Set-Content -NoNewline .secrets/postgres_password
'postgres:5432:linearmemory:linearmemory:defina-localmente' |
  Set-Content -NoNewline .secrets/postgres_pgpass
docker compose config
docker compose up --build -d
```

Bash:

```bash
mkdir -p .secrets
printf '%s' 'defina-localmente' > .secrets/postgres_password
printf '%s' 'postgres:5432:linearmemory:linearmemory:defina-localmente' > .secrets/postgres_pgpass
docker compose config
docker compose up --build -d
```

Serviços:

- Web: `http://localhost:3000`
- MCP: `http://localhost:3333/mcp`
- Health MCP: `http://localhost:3333/health`
- PostgreSQL: `localhost:5432`

## Verificação

```bash
docker compose ps

docker compose exec postgres psql -U linearmemory -d linearmemory \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname IN ('graph', 'vector', 'pg_cron');"

docker compose exec postgres psql -U linearmemory -d linearmemory \
  -c "SELECT * FROM graph.status();"
```

## Fluxo MCP de memória

O fluxo recomendado é explícito e evita criar workspaces duplicados:

1. `find_domain` — encontra o assunto estável acima dos projetos.
2. `create_domain` — cria o domínio somente quando nenhum candidato serve.
3. `find_workspace` — procura um projeto ou fluxo de trabalho já existente.
4. `suggest_workspace` — propõe nome, chave e escopo sem gravar nada.
5. `create_workspace` — cria o workspace somente após busca e proposta.
6. `begin_context` — registra identidade, objetivo, pedido original e ambiente, sem raciocínio privado.
7. `search_memory` — consulta memória durável no workspace ou no domínio.
8. `add_execution_event` — registra eventos observáveis pequenos durante a execução.
9. `find_memory_relations` — inspeciona relações existentes e encontra memórias candidatas sem gravar arestas.
10. `link_memories` — cria ou atualiza uma relação explicada e baseada em evidências, inclusive entre agentes ou workspaces do mesmo domínio.
11. `unlink_memories` — remove uma relação incorreta ou obsoleta e registra o motivo.
12. `record_reflection` — guarda aprendizado de processo separado dos fatos.
13. `complete_execution` — encerra a execução e aplica apenas mudanças de memória explícitas e validadas.

Cada campo dessas tools possui descrição no próprio JSON Schema para orientar a LLM. Quando `agentId` não é informado, o servidor usa `agent_default`. Não existe campo `protocolVersion`; a LLM apenas segue o fluxo indicado pelas descrições das tools.

Eventos aceitos em `add_execution_event`: `ContextStarted`, `MemorySearched`, `MemoryRead`, `MemoryLinked`, `MemoryUnlinked`, `ToolStarted`, `ToolFinished`, `HypothesisCreated`, `DecisionMade`, `ArtifactCreated`, `ProgressUpdated`, `ErrorOccurred`, `CorrectionMade` e `UserFeedbackReceived`.

Tipos de relação aceitos: `supports`, `depends_on`, `caused`, `contradicts`, `refines`, `implements`, `validates`, `supersedes` e `related_to`. A LLM deve chamar `find_memory_relations` antes de `link_memories`, ler as duas memórias e registrar direção, explicação, evidências e confiança. Similaridade textual é apenas uma pista e nunca deve criar uma aresta automaticamente.

Reflexões nunca aparecem em `search_memory`. Elas somente viram memória durável se uma execução posterior validar o aprendizado e o declarar explicitamente em `complete_execution.memoryChanges`.

A projeção pgGraph é reconstruível. As tabelas `memory.memory_nodes` e `memory.memory_relations` permanecem como fonte de verdade.

## Reinicialização completa

Os scripts de inicialização do PostgreSQL só são executados quando o volume é criado:

```bash
docker compose down -v
docker compose up --build -d
```

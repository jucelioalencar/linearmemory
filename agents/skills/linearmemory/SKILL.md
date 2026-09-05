---
name: linearmemory
description: Use LinearMemory MCP to retrieve durable agent knowledge, record observable execution events, relate memories, capture reflection, and consolidate validated outcomes. Use when a task has access to the LinearMemory tools and benefits from cross-session memory; do not store secrets or private reasoning.
---

# LinearMemory

Use LinearMemory as an auditable knowledge protocol, not as a transcript or private-reasoning store. The MCP server's live schemas are authoritative for exact fields and enum values.

## Start an execution

1. Call `find_domain` for the durable product, organization, or initiative. Reuse a suitable result; call `create_domain` only when none exists. Use `update_domain` only for an intentional correction to an existing domain.
2. Call `find_workspace` within that domain. Reuse a suitable workspace; otherwise call `suggest_workspace`, then `create_workspace`. Use `update_workspace` only for an intentional correction.
3. Call `begin_context` with the selected domain and workspace, the real agent identifier, goal, original user request, expected outcome, language, environment, and available model metadata. Use `agent_default` only when the caller cannot identify the agent.
4. Retain the returned `executionId` and use it in every execution-scoped call.
5. Call `search_memory` before choosing an approach. Search by the current problem and constraints rather than copying the entire prompt. When a result affects the work, record a `MemoryRead` event with its memory identifier in metadata.
6. Call `search_reflections` only for process-learning hints. Do not treat a reflection as fact until the current execution validates it.

## During execution

Use `add_execution_event` for small, observable milestones: consequential tool starts/finishes, decisions, artifacts, progress, errors, corrections, and user feedback. Keep sequence numbers increasing within the execution. Describe what happened and its operational consequence. Never persist credentials, tokens, hidden chain-of-thought, or raw transcripts.

Before adding an edge, call `find_memory_relations` and understand both memories. Use `link_memories` only when direction, relation type, explanation, evidence, and confidence are defensible. Use `unlink_memories` to remove an incorrect edge. Use `resolve_memory_conflict` only after evidence supports resolving or dismissing the conflict.

## Complete an execution

1. Verify the requested outcome.
2. Call `record_reflection` with process learning: what worked, what failed, assumptions, lessons, and suggested improvements. Reflection does not create factual memory.
3. Call `complete_execution` exactly once with status, duration, user-facing response, confidence, and explicit memory changes.
4. Consolidate only reusable, validated knowledge. Use `validatedFromReflectionId` when a new memory is supported by a reflection that this execution actually validated.

If LinearMemory is unavailable, report that limitation and never claim a memory read or write occurred.

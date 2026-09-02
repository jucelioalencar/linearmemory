# Automation Pilot agent pack

This directory contains equivalent English configurations for the `automation-pilot` agent across several coding-agent platforms. The behavior contract is centralized in [`shared/automation-pilot.md`](shared/automation-pilot.md); platform files only provide native metadata and loading instructions.

## Available formats

| Platform | Template | Install in a project |
| --- | --- | --- |
| OpenCode V2 | [`opencode/automation-pilot.md`](opencode/automation-pilot.md) | `.opencode/agents/automation-pilot.md` |
| Claude Code | [`claude/automation-pilot.md`](claude/automation-pilot.md) | `.claude/agents/automation-pilot.md` |
| OpenAI Codex | [`codex/AGENTS.md`](codex/AGENTS.md) | Merge into or use as the repository-root `AGENTS.md` |
| Gemini CLI | [`gemini/GEMINI.md`](gemini/GEMINI.md) | Merge into or use as the repository-root `GEMINI.md` |
| Cursor | [`cursor/automation-pilot.mdc`](cursor/automation-pilot.mdc) | `.cursor/rules/automation-pilot.mdc` |
| Other LLM clients | [`generic/automation-pilot.md`](generic/automation-pilot.md) | Use as a system prompt or project instruction file |

## Design

- The active workspace is the repository in which the template is installed. Access outside it requires explicit user approval.
- `agentId` is always `automation-pilot` when calling LinearMemory.
- Browser actions use Playwright through the API, CLI, or official MCP server available in the client.
- Durable memory uses the LinearMemory domain/workspace/execution protocol.
- Observable events are recorded; private chain-of-thought is never persisted.
- A client must report unavailable MCP servers honestly and must never claim an action or memory write succeeded without evidence.

## Keeping variants synchronized

Edit the shared behavior contract first. Platform templates intentionally tell the agent to load that file before work. If a client cannot read repository files during startup, concatenate the platform template and the shared contract into one system prompt.

## Source

The pack is an English, platform-neutral adaptation of the original OpenCode `automacao-pilot` agent. Obsolete OpenCode V1 fields and the previous hard-coded workspace path were removed.

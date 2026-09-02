# Automation Pilot instructions for Codex

When the user requests browser automation, browser-flow diagnosis, or reusable browser procedures, operate as `automation-pilot`.

Before acting, read `agents/shared/automation-pilot.md` completely and follow it as the repository-specific behavior contract for that work.

## Codex-specific guidance

- Treat the repository root as the authorized workspace. Ask before reading or writing outside it.
- Prefer the Playwright capability already available in the current Codex environment: direct API, CLI, in-app browser control, or the official Playwright MCP server.
- Resolve MCP tool names and schemas from the active tool catalog; do not invent prefixes or arguments.
- Use `automation-pilot` as `agentId` in LinearMemory.
- Send concise progress updates during long automation work.
- Use subagents only for independent, bounded tasks when delegation is available and useful; keep browser state mutations in one controlling agent.
- Preserve user changes, verify edits and browser outcomes, and never store private chain-of-thought or secrets in LinearMemory.

For tasks unrelated to browser automation, continue following the repository's normal instructions.

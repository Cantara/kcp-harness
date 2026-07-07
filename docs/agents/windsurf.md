# Windsurf

Windsurf (Codeium) uses a **global** MCP config — not per-project. The harness generates a snippet to merge into the global config, plus a `.windsurfrules` file for project-level governance instructions.

## Setup

```bash
kcp-harness integrate windsurf
```

This generates:

### `windsurf-mcp-snippet.json` (not committed)

A snippet to merge into `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "kcp-harness": {
    "command": "npx",
    "args": ["kcp-harness", "serve"]
  }
}
```

Merge it into your global config:

```json
{
  "mcpServers": {
    "kcp-harness": { ... }
  }
}
```

### `.windsurfrules` (committed)

Project-level governance instructions for Windsurf's Cascade agent:

```
# KCP Knowledge Governance
1. Always call kcp_plan or kcp_load before reading governed files
2. The harness intercepts tool calls and routes through the planner
3. Budget and temporal governance are enforced automatically
...
```

## Why Global?

Windsurf doesn't support per-project MCP config files. The MCP server config lives in `~/.codeium/windsurf/mcp_config.json` and applies to all projects. The `.windsurfrules` file provides project-specific governance instructions.

After modifying the global config, restart Windsurf.

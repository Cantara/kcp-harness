# Claude Code

Claude Code has first-class MCP support and a powerful hooks system (PreToolUse) that enables enforcement at the tool level.

## Setup

```bash
kcp-harness integrate claude-code
```

This generates three files:

### `.mcp.json` — MCP server config

```json
{
  "mcpServers": {
    "kcp-harness": {
      "command": "npx",
      "args": ["kcp-harness", "serve"]
    }
  }
}
```

### `.claude/settings.json` — PreToolUse hooks

The hooks intercept `Read`, `Edit`, `Write`, `Glob`, and `Grep` calls. If the target path is in a governed domain, the hook blocks the call and instructs the agent to use `kcp_load` instead.

### `CLAUDE.md` — Agent instructions

Instructs Claude Code to:
1. Always use `kcp_load` before reading governed files
2. Call `kcp_plan` first to see available units
3. Use `harness_status` to check governance state

## Alternative: Manual MCP setup

```bash
claude mcp add --scope project kcp-harness -- npx kcp-harness serve
```

## How It Works

```
Claude Code → Read("docs/api.md")
  │
  ├── PreToolUse hook fires
  │   └── Path "docs/" is governed → BLOCK
  │       "Use kcp_load to access governed knowledge at docs/api.md"
  │
  └── Claude Code calls kcp_load instead
      └── Harness: 13-gate cascade → approved → returns content
```

The hooks ensure governance even if the model "forgets" to use `kcp_load`. This is the SSH-guard pattern applied to knowledge access.

## Available Tools

Once connected, Claude Code can use these MCP tools:

| Tool | Description |
|---|---|
| `kcp_plan` | Get a deterministic load plan (no content) |
| `kcp_load` | Plan + load eligible unit content |
| `kcp_trace` | 13-gate decision trace |
| `harness_status` | Current governance state |
| `harness_budget` | Session spend tracking |
| `harness_temporal_check` | Plan drift detection |

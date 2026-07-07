# Cursor

Cursor supports MCP servers via `.cursor/mcp.json` and project rules via `.cursor/rules/*.mdc` files with glob-scoped YAML frontmatter.

## Setup

```bash
kcp-harness integrate cursor
```

This generates:

### `.cursor/mcp.json`

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

### `.cursor/rules/kcp-governance.mdc`

A glob-scoped rules file that applies to governed paths:

```markdown
---
description: KCP knowledge governance rules
globs:
  - "docs/**"
  - "src/**"
---

# Rules
1. Always call kcp_load before reading governed files
2. The harness enforces budget and temporal governance
...
```

## How It Works

Cursor loads MCP servers from `.cursor/mcp.json` on startup. The governance rules in `.cursor/rules/kcp-governance.mdc` are automatically applied when the agent works with files matching the glob patterns.

In Agent mode, Cursor can call `kcp_plan`, `kcp_load`, and other harness tools directly.

# GitHub Copilot

GitHub Copilot supports MCP in VS Code (Agent mode only) and via the Copilot CLI.

::: warning
VS Code Copilot uses `"servers"` as the top-level key — **not** `"mcpServers"` like every other agent. The `kcp-harness integrate` command handles this automatically.
:::

## Setup

```bash
kcp-harness integrate copilot
```

This generates:

### `.vscode/mcp.json`

```json
{
  "servers": {
    "kcp-harness": {
      "type": "stdio",
      "command": "npx",
      "args": ["kcp-harness", "serve"]
    }
  }
}
```

Note the `"servers"` key and the additional `"type": "stdio"` field.

### `.github/copilot-instructions.md`

Instructions for Copilot's agent mode, including governed paths, rules, and available MCP tools.

## Agent Mode Required

MCP tools are **only** available in Copilot's Agent mode. They don't work in Ask or Edit mode. In VS Code, switch Copilot Chat to Agent mode to access kcp-harness tools.

## Copilot CLI

For Copilot CLI, add to `~/.copilot/mcp-config.json` instead:

```json
{
  "mcpServers": {
    "kcp-harness": {
      "command": "npx",
      "args": ["kcp-harness", "serve"],
      "tools": ["*"]
    }
  }
}
```

Generate with:

```bash
kcp-harness integrate copilot-cli
```

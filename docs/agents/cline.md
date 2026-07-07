# Cline

Cline supports MCP servers via its VS Code extension settings UI and project-level rules via `.clinerules`.

## Setup

```bash
kcp-harness integrate cline
```

This generates:

### `cline-mcp-snippet.json` (not committed)

Add this via Cline sidebar > MCP Servers tab > gear icon:

```json
{
  "kcp-harness": {
    "command": "npx",
    "args": ["kcp-harness", "serve"],
    "disabled": false,
    "autoApprove": [
      "kcp_plan",
      "kcp_trace",
      "harness_status",
      "harness_session",
      "harness_budget",
      "harness_temporal_check"
    ]
  }
}
```

### `.clinerules` (committed)

Governance rules for Cline, including governed paths and mandatory tool usage.

## Auto-Approve

The `autoApprove` list lets Cline call **read-only** governance tools without a confirmation prompt:

| Tool | Auto-approved | Why |
|---|---|---|
| `kcp_plan` | Yes | Read-only plan inspection |
| `kcp_trace` | Yes | Read-only decision trace |
| `harness_status` | Yes | Read-only status check |
| `harness_budget` | Yes | Read-only budget query |
| `harness_temporal_check` | Yes | Read-only drift check |
| `kcp_load` | **No** | Loads content — requires approval |

This balances governance visibility (the agent can freely inspect plans and traces) with content access control (loading actual content requires human approval).

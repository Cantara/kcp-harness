# Architecture

KCP Harness is an MCP proxy that sits between an AI agent and its tools. It intercepts tool calls, classifies them, and enforces governance on knowledge-related operations.

## Pipeline

Every tool call flows through this pipeline:

```
┌──────────────────────────────────────────────────────────────┐
│  1. RECEIVE          MCP JSON-RPC request from agent         │
│  2. CLASSIFY         Knowledge-nav or pass-through?          │
│  3. GOVERN           Route through 13-gate cascade           │
│  4. EXECUTE          Call downstream tool / return content    │
│  5. AUDIT            Log decision to append-only audit log   │
│  6. RESPOND          Return result + governance metadata     │
└──────────────────────────────────────────────────────────────┘
```

## Classifier

The classifier examines each tool call and determines whether it targets governed knowledge:

| Tool | What's extracted | Governed if... |
|---|---|---|
| `Read` | `file_path` | Path matches a governed domain prefix |
| `Write` / `Edit` | `file_path` | Path matches a governed domain prefix |
| `Glob` | `pattern` prefix | Pattern root matches a governed domain |
| `Grep` | `path` | Search path matches a governed domain |
| `WebFetch` | `url` | URL matches a governed domain URL prefix |
| `Bash` | Command arguments | Contains paths matching governed domains |
| `kcp_*` | Always | KCP tools are always governed |

If a tool call doesn't match any governed domain, it's classified as **pass-through** and forwarded without intervention.

## Governor

The governor enforces the 13-gate cascade from kcp-agent:

```
audience → not_for → temporal → deprecated → supersession →
relevance → attestation → payment → access → strict →
max_units → money_budget → context_budget
```

Two modes:

### Plan-first mode (fast path)
The agent calls `kcp_plan` explicitly. The harness caches the approved plan. Subsequent reads of governed paths are checked against the cached plan — no re-planning needed.

### Auto-plan mode (fallback)
The agent reads a governed path without calling `kcp_plan` first. The harness runs the planner automatically with `access <target-path>` as the task. This is slower but ensures governance even for agents that don't know about `kcp_plan`.

## Session State

The harness maintains session state across calls:

- **Approved plans** — cached plan results, keyed by manifest
- **Known set** — SHA-256 hashes of loaded units (dedup)
- **Budget ledger** — append-only spend tracking with ceiling enforcement
- **Temporal watch** — registered plans checked for drift on each call
- **Sequence counter** — monotonic counter for audit event ordering

## Audit Log

Every decision is logged to an append-only JSONL file:

```json
{
  "seq": 1,
  "ts": "2025-07-07T10:30:00.000Z",
  "type": "tool_call",
  "tool": "Read",
  "governed": true,
  "decision": { "approved": true, "mode": "plan-first" },
  "session": "abc123"
}
```

Event types: `tool_call`, `session_start`, `session_end`, `budget_spend`, `budget_exceeded`, `temporal_drift`, `plan_invalidated`.

## Downstream MCP Servers

The harness can proxy to downstream MCP servers (filesystem, database, etc.). Tool calls that aren't governed are forwarded to the appropriate downstream server based on tool ownership mapping.

```yaml
downstream:
  - name: "filesystem"
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
```

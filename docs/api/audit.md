# Audit Log

The audit log is an append-only JSONL file that records every governance decision. Each line is a self-contained JSON event.

## Location

Default: `.kcp-harness/audit.jsonl` (configurable in `harness.yaml`).

## Event Schema

All events share these fields:

```json
{
  "seq": 1,
  "ts": "2025-07-07T10:30:00.000Z",
  "type": "tool_call",
  "session": "abc123"
}
```

| Field | Type | Description |
|---|---|---|
| `seq` | number | Monotonically increasing sequence number |
| `ts` | string | ISO 8601 timestamp |
| `type` | string | Event type (see below) |
| `session` | string | Session identifier |

## Event Types

### `tool_call`

Logged for every tool call that passes through the harness.

```json
{
  "seq": 1,
  "ts": "2025-07-07T10:30:00.000Z",
  "type": "tool_call",
  "tool": "Read",
  "governed": true,
  "targets": ["docs/api.md"],
  "decision": {
    "approved": true,
    "mode": "plan-first",
    "plan": { "units": 3, "eligible": 2 }
  },
  "session": "abc123"
}
```

### `session_start` / `session_end`

Session lifecycle events.

```json
{
  "seq": 0,
  "ts": "2025-07-07T10:00:00.000Z",
  "type": "session_start",
  "session": "abc123",
  "config": {
    "domains": 1,
    "policy": { "fail_closed": true }
  }
}
```

### `budget_spend`

Logged when knowledge loading incurs a cost.

```json
{
  "seq": 5,
  "ts": "2025-07-07T10:31:00.000Z",
  "type": "budget_spend",
  "source": "plan",
  "cost": { "amount": 0.25, "currency": "USDC" },
  "runningTotal": { "USDC": 0.25 },
  "ceiling": { "amount": 1.00, "currency": "USDC" },
  "session": "abc123"
}
```

### `budget_exceeded`

Logged when a request is rejected because it would exceed the budget ceiling.

```json
{
  "seq": 10,
  "ts": "2025-07-07T10:45:00.000Z",
  "type": "budget_exceeded",
  "requested": { "amount": 0.50, "currency": "USDC" },
  "current": { "USDC": 0.80 },
  "ceiling": { "amount": 1.00, "currency": "USDC" },
  "session": "abc123"
}
```

### `temporal_drift`

Logged when a watched plan's temporal validity changes.

```json
{
  "seq": 15,
  "ts": "2025-07-07T11:00:00.000Z",
  "type": "temporal_drift",
  "manifest": "./knowledge.yaml",
  "summary": "1 unit expired: 'api-v1-docs'",
  "session": "abc123"
}
```

### `plan_invalidated`

Logged when a plan is removed from the session due to drift.

## Security

The audit log **redacts** sensitive content:

- `Write` tool content is replaced with `[REDACTED: <length> chars]`
- `Bash` commands containing common secret patterns are redacted
- Decision trace details (which may contain unit content) are stripped from audit events

## Querying

The JSONL format is designed for streaming processing:

```bash
# All governed tool calls
cat .kcp-harness/audit.jsonl | jq 'select(.governed == true)'

# Budget events
cat .kcp-harness/audit.jsonl | jq 'select(.type | startswith("budget"))'

# Temporal drift events
cat .kcp-harness/audit.jsonl | jq 'select(.type == "temporal_drift")'

# Session summary
cat .kcp-harness/audit.jsonl | jq 'select(.type == "session_end")'
```

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

### `approval_requested`

Logged when a governed call is held for a named human — a ticket was opened.

```json
{
  "seq": 20,
  "ts": "2026-07-20T17:01:04.696Z",
  "type": "approval_requested",
  "outcome": "blocked",
  "approval": {
    "id": "2d62d5a2-…",
    "state": "pending_review",
    "toolName": "Write",
    "target": "records/customer-7.md",
    "requiredRole": "account-owner",
    "policyRef": "POL-7.2",
    "expiresAt": "2026-07-23T17:01:04.696Z"
  },
  "session": "abc123"
}
```

### `approval_resolved`

Logged when a named reviewer approves or dismisses a ticket. The resolution payload is the
evidence — reviewer and policy citation are required, recorded at approval time.

```json
{
  "seq": 21,
  "ts": "2026-07-20T17:05:12.000Z",
  "type": "approval_resolved",
  "outcome": "approved",
  "approval": {
    "id": "2d62d5a2-…",
    "state": "approved",
    "reviewer": "Kari N.",
    "reviewedAt": "2026-07-20T17:05:12.000Z",
    "policyRef": "POL-7.2",
    "target": "records/customer-7.md"
  },
  "session": "abc123"
}
```

### `confidence_verdict`

Logged every time `harness_assess` adjudicates an answer. Records the verdict — score,
threshold, written reason — never the answer text. When the failure was routed to a human,
`ticketId` links to the approval ticket.

```json
{
  "seq": 25,
  "ts": "2026-07-20T18:00:00.000Z",
  "type": "confidence_verdict",
  "outcome": "blocked",
  "confidence": {
    "task": "draft customer risk assessment",
    "passed": false,
    "score": 0.4,
    "threshold": 0.7,
    "severity": "critical",
    "detail": "confidence 0.4 < threshold 0.7 on critical task — self: …",
    "ticketId": "2d62d5a2-…"
  },
  "session": "abc123"
}
```

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

# Human-approval trail: every ticket and who resolved it
cat .kcp-harness/audit.jsonl | jq 'select(.type | startswith("approval"))'

# Confidence gate outcomes
cat .kcp-harness/audit.jsonl | jq 'select(.type == "confidence_verdict")'
```

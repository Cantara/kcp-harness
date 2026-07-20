# MCP Tools

These tools are available to any agent connected to the kcp-harness MCP server.

## `kcp_plan`

Get a deterministic load plan without loading content. Use this to inspect what units are available before loading.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task` | string | Yes | Description of what you're trying to do |
| `manifest` | string | Yes | Path to knowledge manifest |
| `env` | string | No | Environment (affects temporal gates) |
| `audience` | string | No | Requester audience tag |

**Returns:** Plan object with eligible units, their scores, and gate results.

## `kcp_load`

Plan + load eligible unit content. This is the primary tool for accessing governed knowledge.

**Parameters:**

Same as `kcp_plan`.

**Returns:** Plan object + loaded unit content for all eligible units.

## `kcp_trace`

Get a full 13-gate decision trace. Shows exactly which gates each unit passed or failed, and why.

**Parameters:**

Same as `kcp_plan`.

**Returns:** Decision trace with per-unit, per-gate results.

## `kcp_validate`

Validate a knowledge manifest (`knowledge.yaml`).

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | Path to the manifest or directory containing it |

**Returns:** Validation report with errors and warnings.

## `harness_status`

Get the current governance state.

**Returns:**

```json
{
  "session": "abc123",
  "governed_domains": 1,
  "approved_plans": 2,
  "known_units": 5,
  "budget_spent": { "USDC": 0.25 },
  "policy": { "fail_closed": true, "max_units": 5 }
}
```

## `harness_session`

Get session information including known units and approved plans.

**Returns:** Session state with plan cache and known set.

## `harness_budget`

Get the current budget ledger — itemized spend tracking.

**Returns:**

```json
{
  "ceiling": { "amount": 1.00, "currency": "USDC" },
  "spent": { "USDC": 0.25 },
  "remaining": { "USDC": 0.75 },
  "entries": [
    {
      "seq": 1,
      "timestamp": "2025-07-07T10:30:00.000Z",
      "source": "plan",
      "description": "kcp_load: 3 units",
      "cost": { "amount": 0.25, "currency": "USDC" },
      "runningTotal": { "USDC": 0.25 }
    }
  ]
}
```

## `harness_temporal_check`

Check all watched plans for temporal drift. Re-evaluates plans against the current time and reports units that have changed status.

**Returns:**

```json
{
  "drifted": false,
  "plans_checked": 2,
  "results": []
}
```

Or if drift is detected:

```json
{
  "drifted": true,
  "plans_checked": 2,
  "results": [
    {
      "manifest": "./knowledge.yaml",
      "summary": "1 unit expired: 'api-v1-docs' (temporal gate failed)",
      "diff": { ... }
    }
  ]
}
```

## `harness_approvals`

List human-approval tickets: governed calls held for a named reviewer. A call matching a
`governance.approvals` rule is denied with its ticket id — re-try it after a human resolves
the ticket (see [`kcp-harness approvals`](/api/cli#kcp-harness-approvals)).

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `state` | string | No | Filter: `pending_review`, `approved`, `dismissed`, `expired` |

**Returns:**

```json
{
  "approvals": [
    {
      "id": "2d62d5a2-…",
      "state": "pending_review",
      "toolName": "Write",
      "target": "records/customer-7.md",
      "requiredRole": "account-owner",
      "requestedAt": "2026-07-20T17:01:04.696Z",
      "expiresAt": "2026-07-23T17:01:04.696Z",
      "policyRef": "POL-7.2"
    }
  ]
}
```

Resolved tickets additionally carry `reviewer`, `reviewedAt`, and (for dismissals) `note`.

## `harness_assess`

Confidence-gate a synthesized answer **before acting on it**. Runs kcp-agent's post-synthesis
`assess()`: the answer's self-reported confidence is adjudicated deterministically against the
org threshold (the planner gates *loading*, grounding gates *asserting*, this gates *acting*).

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task` | string | Yes | The task the answer concludes |
| `answer` | string | Yes | The synthesized answer to gate |
| `threshold` | number | No | Tightens the configured threshold — the strictest wins, a caller can never loosen org policy |
| `severity` | string | No | Severity label override (e.g. `critical`) |

**Returns:**

```json
{
  "allowed": false,
  "verdict": {
    "gate": "confidence",
    "passed": false,
    "threshold": 0.7,
    "score": 0.4,
    "signals": [{ "source": "self", "score": 0.4, "reasoning": "self-reported: \"Confidence: 0.4\"" }],
    "detail": "confidence 0.4 < threshold 0.7 on critical task — self: …",
    "severity": "critical",
    "asOf": "2026-07-20"
  },
  "ticket": { "id": "…", "state": "pending_review", "requiredRole": "account-owner" }
}
```

Behavior on a failed verdict when `governance.confidence.route_to_role` is set:

- **No ticket yet** → one is opened with the verdict embedded as evidence (`ticket` in the result)
- **Pending** → the same ticket is returned; no duplicate is opened
- **Approved by a named human** → `allowed: true` with the `override` (reviewer, policyRef) attached — the verdict still records that the gate itself failed
- **Dismissed** → terminal; `dismissed` (reviewer, note) attached, no new ticket

Fail-closed: an answer with no confidence signal at all fails the gate with a specific reason.

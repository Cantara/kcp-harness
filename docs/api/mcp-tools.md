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

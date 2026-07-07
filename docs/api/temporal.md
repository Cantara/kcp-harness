# Temporal Governance

Knowledge units can have time-based constraints. The harness monitors these and detects when plans drift out of temporal validity.

## How It Works

1. When a plan is created (`kcp_plan` or `kcp_load`), the harness registers it with the **temporal watcher**
2. On subsequent tool calls, the watcher re-evaluates plans against the current time
3. If units have drifted (expired, newly valid, embargo lifted), a `temporal_drift` event is emitted
4. The agent can explicitly check drift via `harness_temporal_check`

## Temporal Gates

The 13-gate cascade includes temporal checks:

| Gate | What it checks |
|---|---|
| `temporal` | Is the unit valid at the current time? (valid-from / valid-until) |
| `deprecated` | Has the unit been deprecated? |
| `supersession` | Has a newer unit superseded this one? |

## Drift Detection

Drift occurs when a plan that was valid at creation time is no longer valid:

- A unit's `valid_until` date has passed
- A unit's `valid_from` date has arrived (newly available)
- A unit has been superseded by a newer version

### Checking for Drift

```
Agent → harness_temporal_check
Harness → re-run planTree for each watched plan
         → diff new plan against original
         → return drift results
```

### Drift Response

```json
{
  "drifted": true,
  "plans_checked": 2,
  "results": [
    {
      "manifest": "./knowledge.yaml",
      "summary": "1 unit expired: 'api-v1-docs' (temporal gate failed)",
      "addedUnits": [],
      "removedUnits": ["api-v1-docs"],
      "scoreChanges": []
    }
  ]
}
```

## Long-Running Sessions

For long-running agent sessions (hours or days), temporal governance ensures that:

- Knowledge loaded at the start is still valid
- New knowledge that became available is surfaced
- Expired knowledge is flagged before the agent relies on it

The agent should call `harness_temporal_check` periodically in long sessions.

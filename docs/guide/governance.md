# Governance Model

KCP Harness enforces a **deterministic, fail-closed** governance model. This page explains the principles and mechanics.

## Fail-Closed

The default posture is **deny**. If any of the following are true, knowledge access is blocked:

- The manifest can't be loaded
- The plan rejects all units
- A unit fails any of the 13 gates
- The budget ceiling is exceeded
- The temporal validity check fails

There is no "best-effort" mode. Either the request is explicitly approved through the gate cascade, or it's blocked.

## The 13-Gate Cascade

Every knowledge unit is evaluated through 13 deterministic gates, in order:

| # | Gate | What it checks |
|---|---|---|
| 1 | `audience` | Is the requester in the target audience? |
| 2 | `not_for` | Is the requester explicitly excluded? |
| 3 | `temporal` | Is the unit valid at the current time? |
| 4 | `deprecated` | Has the unit been deprecated? |
| 5 | `supersession` | Has a newer unit superseded this one? |
| 6 | `relevance` | Is the unit relevant to the task? |
| 7 | `attestation` | Does the unit have required attestations? |
| 8 | `payment` | Does access require payment? |
| 9 | `access` | Does the requester have access rights? |
| 10 | `strict` | In strict mode, is relevance high enough? |
| 11 | `max_units` | Would this exceed the unit count limit? |
| 12 | `money_budget` | Would this exceed the monetary budget? |
| 13 | `context_budget` | Would this exceed the token budget? |

A unit must pass **all** gates to be included in the plan. The gate that blocks it is recorded in the decision trace.

## Decision Traces

Every plan produces a decision trace — a structured record of which gates each unit passed or failed. Traces are:

- **Deterministic** — same inputs produce identical traces
- **Complete** — every unit in the manifest is evaluated
- **Timestamped** — temporal gates are evaluated against a pinned time
- **Replayable** — traces can be re-evaluated against different parameters

## Budget Enforcement

The harness tracks spend via an **append-only ledger**:

- Each `kcp_load` records the cost of loaded units
- Running totals are maintained per currency
- If a load would exceed the budget ceiling, the entire load is rejected (no partial loads)
- The ledger can be queried via `harness_budget`

## Temporal Governance

Knowledge units can have temporal constraints (valid-from, valid-until, embargo dates). The harness:

1. Pins the evaluation time when a plan is created
2. Registers the plan with the temporal watcher
3. On subsequent calls, re-evaluates plans against current time
4. If units have drifted (expired, newly valid), emits a `temporal_drift` event
5. The agent can check drift via `harness_temporal_check`

## Session Dedup

The harness tracks which units have been loaded in the current session. If an agent requests a unit that's already loaded (same SHA-256 hash), the harness returns an "unchanged" stub instead of re-loading the content. This prevents:

- Redundant knowledge loading
- Double-counting in the budget ledger
- Context window waste

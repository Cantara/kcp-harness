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

## Human-Approval Gates

Some governed actions must not be decided by the automated cascade alone: org policy demands a
**named human** sign off, and that can take minutes or days. Calls matching a
`governance.approvals` rule enter a durable ticket state machine:

```
pending_review ──▶ approved   (terminal, named reviewer)
       │─────────▶ dismissed  (terminal, named reviewer)
       └─────────▶ expired    (terminal, TTL — fail-closed)
```

Three invariants:

1. **Approval rules outrank every automated path.** An approved plan cannot bypass a human
   gate — the rule check runs first.
2. **Resolutions are never anonymous.** A resolution requires a named reviewer *and* a policy
   citation (`policyRef`). `approved: true` alone is rejected as evidence. The evidence is
   generated at approval time, never reconstructed from logs.
3. **Tickets survive restarts.** Sessions are ephemeral; human review is not. The default
   file provider persists every ticket, and a CLI in another process resolves it.

MCP has no async answer, so a pending call is denied with a structured reason carrying the
ticket id and required role. The agent re-tries after approval (or checks
[`harness_approvals`](/api/mcp-tools#harness-approvals)). On retry the governor honors the
resolution: approved → allowed with the resolution attached; dismissed → terminal block.

The provider interface (`submit` / `check` / `resolve` / `list`) is channel-agnostic — Slack,
email, or ticketing integrations are org-side implementations of the same surface the built-in
[`kcp-harness approvals`](/api/cli#kcp-harness-approvals) CLI uses.

## Post-Synthesis Confidence Gate

The 13 gates all evaluate declared unit properties *before* anything is generated. Confidence
is a property of the model's **output** — so it is a separate, later stage, downstream of
synthesis:

> The planner decides what may be **loaded**; grounding decides what may be **asserted**;
> [`harness_assess`](/api/mcp-tools#harness-assess) decides what may be **acted on**.

The harness calls kcp-agent's `assess()`: confidence is a *proposal* (the answer's
self-report, or an injected evaluator); the gate *adjudicates* deterministically against the
configured threshold. The verdict is binary with a written, specific reason — the same
contract as the 13 pre-selection gates.

- **Strictest threshold wins** — a caller may tighten org policy, never loosen it
- **Fail-closed** — no obtainable confidence signal fails the gate with a specific reason
- **Route-to-human** — a failed verdict on a `route_to_role` config opens an approval ticket
  with the full verdict embedded as evidence ("below threshold on critical → route to a
  human" *is* a pending approval)
- Every adjudication is a `confidence_verdict` audit event — score, threshold, reasoning;
  never the answer text

## Session Dedup

The harness tracks which units have been loaded in the current session. If an agent requests a unit that's already loaded (same SHA-256 hash), the harness returns an "unchanged" stub instead of re-loading the content. This prevents:

- Redundant knowledge loading
- Double-counting in the budget ledger
- Context window waste

# Governance Model

KCP Harness enforces a **deterministic, fail-closed** governance model. This page explains the principles and mechanics.

## Fail-Closed

The default posture is **deny**. If any of the following are true, knowledge access is blocked:

- The manifest can't be loaded
- The plan rejects all units
- A unit fails any of the 14 gates
- The budget ceiling is exceeded
- The temporal validity check fails

There is no "best-effort" mode. Either the request is explicitly approved through the gate cascade, or it's blocked.

## The 14-Gate Cascade

Every knowledge unit is evaluated through 14 deterministic gates, in order (kcp-agent v0.16.0,
`skill_eligibility` added #100/#101):

| # | Gate | What it checks |
|---|---|---|
| 1 | `audience` | Is the requester in the target audience? |
| 2 | `not_for` | Is the requester explicitly excluded? |
| 3 | `temporal` | Is the unit valid at the current time? |
| 4 | `deprecated` | Has the unit been deprecated? |
| 5 | `supersession` | Has a newer unit superseded this one? |
| 6 | `relevance` | Is the unit relevant to the task? |
| 7 | `skill_eligibility` | For a `kind: skill` unit: does it carry an explicit `load_eligible: true` grant? |
| 8 | `attestation` | Does the unit have required attestations? |
| 9 | `payment` | Does access require payment? |
| 10 | `access` | Does the requester have access rights? |
| 11 | `strict` | In strict mode, is relevance high enough? |
| 12 | `max_units` | Would this exceed the unit count limit? |
| 13 | `money_budget` | Would this exceed the monetary budget? |
| 14 | `context_budget` | Would this exceed the token budget? |

A unit must pass **all** gates to be included in the plan. The gate that blocks it is recorded in the decision trace. See **Governed Skills** below for what happens once a `kind: skill` unit clears gate 7 and is actually invoked.

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
pending_review ──▶ approved   (named reviewer — a bounded grant, see below)
       │               └──▶ used      (terminal, a `once` grant consumed by a call)
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
resolution: approved *and the grant still covers the call* → allowed with the resolution
attached; dismissed → terminal block.

### Approval grants

An approval is the scope of **one human decision**, never a standing permission — a standing
permission is a policy rule, not a click. An approved ticket is a *grant*, bound to:

- the **session** that opened the ticket (`request.sessionId`),
- the exact **tool and target**,
- the **arguments digest** of the intercepted call (SHA-256 of the canonical JSON of the
  arguments, excluding `traceparent` and `_meta`). Limit: the digest covers the arguments as the
  proxy received them; a retry with different arguments is a different decision and opens a new
  ticket. See [Argument binding](#argument-binding) for tickets that carry no digest.

and it lapses, as set by the rule's `grant`:

| `grant` | Valid for |
|---|---|
| `once` | The first matching call. The ticket then moves to the terminal state `used`, recorded in the store with the correlation id of the call that used it. Consumption is atomic: of N concurrent calls exactly one succeeds. |
| `session` (default) | Calls from the opening session, until `grant_max`. |
| `15m` / `4h` / `1d` | That long after the reviewer approved, same session, capped by `grant_max`. |

`governance.approvals.grant_max` (default `24h`) is a hard ceiling on every grant, measured from
the moment the **store** recorded the approval — including `once` grants that are never used. An
approval is never permanent.

**Trusted time.** The window is *not* measured from the resolution's `reviewedAt`, which the
reviewer (or whatever wrote the record) supplies. The provider stamps `resolvedAtStore` from its own
clock when it appends the resolution, overwriting anything the caller sent, and every window
(`once`, `session`, a duration, and the `grant_max` cap) starts there. `reviewedAt` stays on the
record as display and evidence. Consequently:

- a back-dated `reviewedAt` does not shorten a grant, and a future-dated one does not extend it;
- `resolve()` refuses a `reviewedAt` more than `approvals.max_reviewed_at_skew` (default `5m`)
  ahead of the store's clock, or earlier than the ticket's `requestedAt`; a record found in the
  store that breaks the same rules (or whose own stamp is in the future) is **ignored** on read;
- a resolution written by a harness before the stamp existed (a *legacy* resolution) has no
  `resolvedAtStore`. Its window starts at `min(reviewedAt, modification time of the store file,
  now)` — the file's mtime is the store's own clock but only an upper bound on when the line was
  written (the file may have been appended to since), so a legacy window can start later than the
  real approval by at most the time since the file was last written, and never later than now. It
  can no longer be pushed into the future by the record itself. `approvals list` marks these
  `[legacy time]`.

A call outside a valid grant is **not** approved. It opens a new `pending_review` ticket and the
audit log records a `grant_denied` event with the reason: `expired`, `wrong_session`, `used`,
`args_mismatch` or `invalid` (plus a finer `detail` such as `args_unbound` or `resolution_ignored`).
`kcp-harness approvals list` shows used tickets (`used`), the opening session of every ticket, and
flags approved tickets whose grant lapsed (`[grant expired]`).

Only tickets for the **same session, tool, target** (and arguments) are considered, and the
newest decides: an older approval never outlives a newer dismissal or a newer pending ticket.

**Fail-closed.** If a grant cannot be evaluated — unreadable store, corrupt ticket (unparseable
`reviewedAt`, unknown grant mode), missing session id, or a custom provider that implements no
`consume()` for a `once` grant — the call is not approved (`invalid`).

**Migration.** Tickets approved before grants existed carry no grant metadata. They are treated
as `session`-scoped by their `request.sessionId` and expire at the trusted resolution time +
`grant_max`. They have no arguments digest and no `argsBound` flag (*legacy* tickets, see below).
Previously such an approval was permanent and cross-session; after upgrading, an old approval no
longer authorises a new session or anything older than `grant_max`. Re-approval is the intended
path.

### Argument binding

A ticket opened by the proxy for an ordinary governed call always carries the `argsDigest` of that
call's arguments, and a grant covers only a call with the same digest. Some tickets cannot:

| Ticket | `argsDigest` | `argsBound` | Covers |
|---|---|---|---|
| bound (every governed tool call, every conformance hold) | yes | — | the exact (tool, target) **and** arguments |
| unbound | no | `false`, with `argsUnboundReason` | the exact (tool, target), any arguments |
| legacy (written before binding was explicit) | no | absent | the exact (tool, target), any arguments |

The tickets the harness opens itself are unbound only for **`harness_assess`**: it has no call
arguments to digest — the task text is its target — so its ticket says
`argsBound: false, argsUnboundReason: "no_call_arguments"`. A custom caller of `newRequest()` that
supplies no digest gets `argsBound: false, argsUnboundReason: "not_supplied"`; it never produces a
silent unbound ticket.

An unbound grant is valid only for the exact (tool, target), only for `once` or `session` grants
(a duration grant on an unbound ticket is refused), and never beyond `grant_max`. Each time one is
used the audit log records a `grant_unbound` event (and the decision in the `tool_call` event
carries `grantUnbound`). Legacy tickets keep the pre-binding rule so an upgrade does not strand
pending work, and are marked `[legacy: args unbound]` in `approvals list`; explicit unbound tickets
show `[args unbound: <reason>]`.

`governance.approvals.require_args_binding: true` makes an unbound or legacy ticket **never** a
grant (`grant_denied`, reason `invalid`, detail `args_unbound`; the call then opens a new, bound
ticket). The one exemption is a ticket whose reason is `no_call_arguments`, because for a call with
no arguments the (tool, target) *is* the whole call; without it the confidence-gate override could
never be granted. The default is `false` for compatibility; **`true` is recommended** for any
deployment that does not hold pre-upgrade tickets.

### Ticket records on read

The file store is an append-only log that is *replayed on every read*, so a record can reach it
without going through `resolve()`. The read path therefore holds the same line `resolve()` does:

- **Signatures.** With `require_signed_resolutions: true`, every resolution is verified when read
  (against `trusted_keys`, if set). An unsigned or unverifiable one is **ignored**: the ticket
  reads as still pending, no grant results, `approvals list` shows `[unsigned: ignored]` (or
  `[bad signature: ignored]`), and a call that hits the ticket is denied with `grant_denied`,
  reason `invalid`, detail `resolution_ignored`. A forged line cannot shut a legitimate reviewer
  out: the next *valid* resolution still resolves the ticket.
- **First terminal resolution wins.** The first valid `approved` / `dismissed` record for a ticket
  is its resolution; every later record for the same ticket id is ignored and counted, whatever it
  says (`approvals list` shows `[extra record ignored]`, the audit log records one
  `approval_record_ignored` event per ticket per process). So a dismissed ticket cannot be
  re-approved by an appended line, an approved one cannot be flipped to dismissed, a `used` ticket
  stays `used`, and a record whose trusted time is after the ticket's `expires_after` does not
  resurrect an expired ticket. `resolve()` refuses a second resolution of a terminal ticket and
  detects losing a race to another writer.
- **Malformed or time-implausible records** (no reviewer or `policyRef`, unparseable dates, a future
  stamp, a `reviewedAt` before the ticket's `requestedAt`) are ignored the same way.
- A second `request` line that reuses an existing ticket id cannot replace the ticket's terms; the
  first one wins.

The `once` guarantee is unchanged: consuming a grant is still a compare-and-swap on the first
`use` record in log order.

### Ticket store trust model

The built-in file store is a **trusted-writer** medium: it assumes that whoever can write to its
directory is allowed to. The hardening above narrows what a *mistaken or careless* writer can do; it
does not make the directory a security boundary. Plainly, what the store does **not** protect:

- **Deletion and truncation.** Anyone with write access to the store directory can delete or
  truncate `approvals.jsonl`. A deleted resolution reads as a pending ticket (fail-closed for that
  ticket), a deleted *request* makes the ticket vanish, and a deleted `use` record makes a consumed
  `once` grant usable again. The audit log's hash chain shows tampering with *the audit log*; the
  ticket store has no equivalent.
- **Forged approvals when signatures are not required.** Without `require_signed_resolutions`, a
  well-formed `approved` line written straight into the file is accepted: nothing proves a human
  wrote it. The read-path checks above stop it from being *stronger* than `resolve()` would allow
  (time, ordering, terminal states), not from existing. **Turn on `require_signed_resolutions` and
  pin `trusted_keys` for any deployment where the store directory is writable by a process the
  agent can influence.**
- **Forgery with signatures on.** A valid forged record needs the reviewer's private key. Without
  `trusted_keys` the signature's *embedded* key is used, which proves the record was not altered
  but not *who* signed it — anyone can sign with a key of their own. Pin `trusted_keys`.
- **The store's time is not signed.** The signature commits to `reviewedAt`, not to
  `resolvedAtStore`. A writer holding a validly signed record can append it later with a store
  stamp of their choosing (bounded to the past by the checks above, never beyond now plus the
  skew): this can only start a grant window *earlier* than the real approval or lose time to
  `grant_max`, but it can replay a stolen signed approval for the ticket it was signed for, until
  the ticket's expiry or `grant_max`.
- **Legacy records** (no store stamp) are trusted at `min(reviewedAt, file mtime, now)`; a backdated
  unsigned legacy-style line is indistinguishable from a real old one.
- **Clock integrity.** Time is the provider's clock. An attacker who controls the host clock
  controls every window.
- **Availability.** Appending garbage cannot grant anything, but it can leave a ticket unreadable
  (torn lines are skipped) or flood the log.

For stronger guarantees, implement `ApprovalProvider` over a store with its own access control and
append-only history (a ticketing system, a database with a service account), and sign resolutions.

### Scope of the pass-through

A tool call the classifier does not place under a governed domain is passed through
(`kcp-passthrough`, "ungoverned tool call"). That is the intended boundary: the harness governs
the domains an operator declares, not every tool the agent holds. Approval rules apply only
inside governed domains.

The provider interface (`submit` / `check` / `resolve` / `list`) is channel-agnostic — Slack,
email, or ticketing integrations are org-side implementations of the same surface the built-in
[`kcp-harness approvals`](/api/cli#kcp-harness-approvals) CLI uses.

## Post-Synthesis Confidence Gate

The 14 gates all evaluate declared unit properties *before* anything is generated. Confidence
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

## Governed Skills — the harness enforces `skill_eligibility`

A `kind: skill` unit (spec §4.3a) is a procedure, not a document — something an agent could
*do*. When a governed tool call is classified as a skill invocation, the harness runs
kcp-agent's `skill_eligibility` gate itself, before the skill's tool call is ever forwarded
downstream:

- **Ineligible → refused, fail-closed.** No `load_eligible: true` grant means the call never
  reaches the downstream tool. A `skill_loaded` audit event with `eligible: false` records the
  gate's exact written reason.
- **Eligible → loaded, and its `action_scope` becomes binding.** The skill's declared
  `action_scope` (`tools`/`paths`/`capabilities`) is attached to the session as the *active
  skill* — every subsequent governed call in that session is now checked against it (see
  **Procedural Conformance**, next). A skill with no declared scope binds an *empty* one —
  fail-closed, not permissive.
- Skill invocations skip the generic plan governor entirely — a skill id is not a file path to
  plan against, so `skill_eligibility` is the whole story for whether it runs.

Every verdict is a `skill_loaded` (`eligible: true` or `false`) audit event, carrying the
skill's id, the deciding gate, its written reason, and its `action_scope`.

> **Authoring skill units:** the conventions for what a *good* `kind: skill` +
> `action_scope` looks like, the SK001–SK008 linter, the conformance vectors (canonical
> fixtures for testing any producer or consumer of skill units — including this
> harness's gate), and a curated library of governed playbooks live in
> [Cantara/kcp-skill](https://github.com/Cantara/kcp-skill). Lint a manifest's skill
> units with `npx kcp-skill-lint knowledge.yaml`.

## Procedural Conformance — grounding for actions

Loading a skill is not a blank check. Once one is active, **every subsequent governed tool
call in that session** is adjudicated against *that skill's* declared `action_scope` before
the generic governor runs — the same "cite it or it doesn't count" discipline kcp-agent's
answer-grounding applies to claims, applied to actions:

- A call that stays within the active skill's `tools`/`paths`/`capabilities` proceeds.
- A call that strays outside it is held **fail-closed** — surfaced as a gap, routed to a
  human, never silently narrowed or silently allowed. The reviewer role and policy citation
  come from [`governance.conformance`](/guide/configuration#conformance-routing) — falling
  back to `governance.confidence`'s routing if that block is absent, then to a hardcoded
  default role (`governance-reviewer`) with no policy citation (#43).
- This check runs *before* plan governance: a scope violation is decided by the loaded skill
  alone, independent of whether a plan would otherwise have approved the call.

Every adjudication is a `conformance_verdict` audit event, naming the active skill, the tool
invoked, the deciding target (the violating one, on a hold), and — on a hold — a ticket id if
the violation was routed for review.

## Decision-Record Correlation

Every tool call the harness intercepts produces a *chain* of verdicts as it moves through
classification, governance, skill-gating, and confidence adjudication. A single
**correlation id** ties that whole chain together in the audit log, so a reviewer (or an
export) can reconstruct exactly which verdicts belong to which action instead of correlating
timestamps by hand.

Per the KCP spec (§3.2 propagation / §17 observability), the harness reuses an incoming
[W3C `traceparent`](https://www.w3.org/TR/trace-context/) when the caller supplies one — its
trace-id becomes the correlation id, its span-id becomes the parent — so harness records
stitch directly into the caller's own distributed trace. Absent a valid traceparent, the
harness mints a fresh id. Every audit event in a chain carries `correlationId` (and
`parentId`, when derived from an incoming trace).

## Session Dedup

The harness tracks which units have been loaded in the current session. If an agent requests a unit that's already loaded (same SHA-256 hash), the harness returns an "unchanged" stub instead of re-loading the content. This prevents:

- Redundant knowledge loading
- Double-counting in the budget ledger
- Context window waste

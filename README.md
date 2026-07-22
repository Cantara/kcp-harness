# kcp-harness

### 🧾 See it run — [interactive KCP playground](https://cantara.github.io/pi-kcp/playground/) · [read the reveal](https://wiki.totto.org/blog/2026/07/22/the-ai-agent-that-keeps-the-receipts/)


**Deterministic knowledge governance for any AI agent.**

> *Your agent can read every file in your project. Can it prove why it read what it read?*

KCP Harness is an MCP compliance proxy that sits between an AI coding agent and its tools. It
intercepts knowledge-related calls, routes them through the
[kcp-agent](https://github.com/Cantara/kcp-agent) deterministic planner (13-gate cascade, no LLM),
and produces compliance artifacts — decision traces, audit logs, budget ledgers — as a side effect
of normal agent operation.

The agent can't bypass governance because it only talks to the proxy's MCP interface. The proxy
decides what knowledge is accessible, tracks spend, and logs every decision. **Fail-closed: if the
harness can't verify a request, the agent gets nothing.**

```
Agent (Claude Code / Cursor / Copilot / Windsurf / Cline / Crush / OpenClaw / ...)
  │
  │  MCP tool call
  v
┌─────────────────────────────────────────────────────────┐
│  kcp-harness                                            │
│                                                         │
│  classify → govern (13 gates) → execute → audit         │
│                                                         │
│  Side outputs:                                          │
│  · Decision traces     (per-request, deterministic)     │
│  · Audit log           (append-only JSONL)              │
│  · Budget ledger       (itemized, ceiling-enforced)     │
│  · Temporal drift      (plan validity over time)        │
│  · Approval tickets    (named-human sign-off, durable)  │
│  · Confidence verdicts (post-synthesis gate)            │
└─────────────────────────────────────────────────────────┘
  │
  v
Knowledge manifests (knowledge.yaml)
```

**[Documentation →](https://cantara.github.io/kcp-harness/)**

## Why

Enterprises need agents that are *defensible* — auditable, reproducible, budget-controlled,
temporally pinned. Today's agents can't prove why they read what they read. The harness adds a
compliance layer without replacing the agent.

| What you keep | What the harness adds |
|---|---|
| Your agent (Claude Code, Cursor, Copilot, ...) | Deterministic knowledge selection |
| Your workflow (coding, reviewing, shipping) | Decision traces (13 gates per unit) |
| Your tools (MCP servers, shell, browser) | Budget enforcement (ceiling, per-currency) |
| | Temporal governance (drift detection) |
| | Append-only audit log |
| | Replay / cross-examination |
| | Human-approval gates (named reviewer + policy citation) |
| | Confidence gating (post-synthesis, route-to-human) |

**You sell the compliance layer. The agents are pluggable.**

## Install

```bash
npm install -g kcp-harness
```

Or use without installing:

```bash
npx kcp-harness --help
```

### Native executables

Pre-built binaries (no Node/Deno required) for Linux x64/arm64, macOS x64/arm64, and Windows x64
— grab them from a [release](https://github.com/Cantara/kcp-harness/releases). To build one yourself:

```bash
npm ci && npm run build
deno compile --allow-read --allow-env --allow-net --allow-run \
  --node-modules-dir=auto --output kcp-harness dist/cli.js
```

## Quick start

### 1. Initialize

```bash
kcp-harness init          # creates harness.yaml
```

### 2. Generate agent integration

```bash
kcp-harness integrate claude-code    # or: pi, cursor, copilot, windsurf, cline, continue, crush, openclaw
```

### 3. Start coding

Your agent now routes knowledge access through the harness. Every decision is logged.

## Supported agents

| Agent | Config | Integration |
|---|---|---|
| **Claude Code** | `.mcp.json` + PreToolUse hooks | `kcp-harness integrate claude-code` |
| **Cursor** | `.cursor/mcp.json` + `.mdc` rules | `kcp-harness integrate cursor` |
| **GitHub Copilot** | `.vscode/mcp.json` (uses `"servers"` key) | `kcp-harness integrate copilot` |
| **Windsurf** | global config + `.windsurfrules` | `kcp-harness integrate windsurf` |
| **Cline** | MCP settings + `.clinerules` | `kcp-harness integrate cline` |
| **Continue** | `.continue/mcpServers/*.yaml` | `kcp-harness integrate continue` |
| **Crush** | `crush.json` + PrepareStep | `kcp-harness integrate crush` |
| **OpenClaw** | `openclaw.json` + plugin hooks | `kcp-harness integrate openclaw` |
| **Pi** | `.pi/mcp.json` + project skills | `kcp-harness integrate pi` |

Each agent has its own MCP config format, rules file, and quirks. The `integrate` command handles
them all — one governance layer, any agent.

## How it works

Every tool call flows through a five-stage pipeline:

```
1. RECEIVE      MCP JSON-RPC request from agent
2. CLASSIFY     Knowledge-navigation or pass-through?
3. GOVERN       13-gate cascade (audience → temporal → budget → ...)
4. EXECUTE      Call downstream tool / return content
5. AUDIT        Log decision to append-only audit log
```

### Classifier

The classifier examines each tool call and determines whether it targets governed knowledge.
`Read("docs/api.md")` where `docs/` is governed? Route through the planner. `Read("package.json")`
where `package.json` isn't governed? Pass through. KCP tools (`kcp_plan`, `kcp_load`) are always
governed.

### Governor

Two automated modes, plus a human gate that outranks both:

- **Plan-first (fast path)** — the agent calls `kcp_plan` first. The harness caches the approved
  plan. Subsequent reads are checked against the cached plan — no re-planning.
- **Auto-plan (fallback)** — the agent reads a governed path without planning. The harness runs
  the planner automatically. Slower, but governance is enforced even for agents that don't know
  about `kcp_plan`.
- **Human approval** — calls matching a `governance.approvals` rule are held for a named
  reviewer (`pending`), no matter what the automated paths would decide. Tickets survive
  restarts and resolve via the `kcp-harness approvals` CLI (or any custom `ApprovalProvider`
  channel). Resolutions require a named reviewer *and* a policy citation.

### The 13-gate cascade

Every knowledge unit is evaluated through 13 deterministic gates, in order:

```
audience → not_for → temporal → deprecated → supersession → relevance →
attestation → payment → access → strict → max_units → money_budget → context_budget
```

A unit must pass **all** gates. The gate that blocks it is recorded in the decision trace. Same
inputs → same plan. No model involved.

## MCP tools

Once connected, agents can use these governance tools:

| Tool | Description |
|---|---|
| `kcp_plan` | Deterministic load plan — which units, in what order, which skipped and why |
| `kcp_load` | Plan + load eligible unit content |
| `kcp_trace` | Full 13-gate decision trace |
| `kcp_validate` | Lint a `knowledge.yaml` |
| `harness_status` | Current governance state |
| `harness_session` | Approved plans + known units for this session |
| `harness_budget` | Itemized spend tracking |
| `harness_temporal_check` | Plan drift detection |
| `harness_approvals` | Human-approval tickets (pending / approved / dismissed / expired) |
| `harness_assess` | Confidence-gate a synthesized answer before acting on it |

## Compliance artifacts

### Audit log

Append-only JSONL. Every decision — governed or pass-through — is logged with sequence number,
timestamp, tool, targets, and governance decision:

```bash
cat .kcp-harness/audit.jsonl | jq 'select(.governed == true)'
```

### Budget ledger

Append-only itemized spend tracking. Per-currency running totals. Ceiling enforcement — a load
that would exceed the budget is rejected atomically (no partial loads).

### Temporal governance

Plans are registered with a temporal watcher. On subsequent calls, the watcher re-evaluates
against the current time. If units have drifted (expired, newly valid), the harness emits a drift
event. Long-running sessions stay honest.

### Approval tickets

Calls matching an approval rule open a durable ticket
(`pending_review → approved | dismissed | expired`). The ticket store survives restarts —
sessions are ephemeral, human review is not. Every resolution records *who* approved,
*when*, and *which policy* it satisfies — evidence generated at approval time, never
reconstructed from logs.

### Confidence verdicts

`harness_assess` runs [kcp-agent](https://github.com/Cantara/kcp-agent)'s post-synthesis
`assess()` over a synthesized answer before it may be acted on. The planner gates *loading*,
grounding gates *asserting*, this gates *acting*. Below-threshold verdicts on routed configs
open an approval ticket with the full verdict embedded as evidence.

## Configuration

```yaml
# harness.yaml
version: "1.0"

governance:
  domains:
    - manifest: "./knowledge.yaml"
      paths: ["docs/", "src/"]

  policy:
    fail_closed: true
    audit_all: true
    max_units: 5
    budget:
      amount: 1.00
      currency: USDC

  confidence:                  # optional post-synthesis gate (harness_assess)
    threshold: 0.7
    severity: critical
    route_to_role: account-owner

  approvals:                   # optional human-approval gates
    provider: file
    rules:
      - match: { tools: [Write, Edit], paths: [records/] }
        required_role: account-owner
        expires_after: 72h
        policy_ref: POL-7.2

audit:
  path: ".kcp-harness/audit.jsonl"
```

## CLI

```
kcp-harness serve  [--config harness.yaml]   Start the MCP proxy
kcp-harness init                             Create a harness.yaml template
kcp-harness check  [--config harness.yaml]   Validate configuration
kcp-harness integrate <agent> [options]       Generate agent integration files
kcp-harness integrate --list                  List supported agents
kcp-harness export   [options]               Export compliance evidence (SOC 2 / ISO 27001)
kcp-harness dashboard [options]              Launch the live compliance dashboard
kcp-harness approvals list [--state s]        List human-approval tickets
kcp-harness approvals approve <id> --reviewer <name> --policy-ref <ref>
kcp-harness approvals dismiss <id> --reviewer <name> --policy-ref <ref>
```

## Library

```ts
import { classify, govern, BudgetLedger, TemporalWatch } from "kcp-harness";
import { generate, listAgents } from "kcp-harness";

// Classify a tool call
const result = classify("Read", { file_path: "docs/api.md" }, governedDomains);

// Generate integration files
const output = generate("claude-code", { manifest: "./knowledge.yaml", paths: ["docs/"] });
```

## Architecture

```
┌──────────────────────────────────────────────┐
│  Layer 3: Integration Packages               │
│  Agent-specific configs + rules files        │
│  (claude-code, cursor, copilot, ...)         │
├──────────────────────────────────────────────┤
│  Layer 2: KCP Compliance Harness             │  ← THIS
│  MCP proxy — deterministic governance        │
├──────────────────────────────────────────────┤
│  Layer 1: kcp-agent (planner core)           │
│  13-gate cascade, decision traces            │
└──────────────────────────────────────────────┘
```

**Forking agents puts you in competition. A harness puts you in composition.**

## Tests

```bash
npm test     # 314 tests across 20 test files
```

Covers the classifier, governor (incl. approval precedence), approval state machine + providers,
confidence-gate wiring, proxy, audit, budget ledger, temporal watch, evidence export, dashboard,
and all agent integrations.

## License

Apache-2.0 · By [eXOReaction AS](https://www.exoreaction.com), hosted under
[Cantara](https://github.com/Cantara).

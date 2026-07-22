# Compliance Export

KCP Harness can generate compliance evidence bundles from its audit log, mapped to SOC 2 Type II, ISO 27001:2022, ISO/IEC 42001 (AI Management System), and EU AI Act controls.

<div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0">
<a href="/kcp-harness/demo-compliance-export.html" target="_blank" style="display:inline-block;padding:8px 20px;background:#e8b45c;color:#0d1117;border-radius:6px;text-decoration:none;font-weight:600">Interactive Demo →</a>
<a href="/kcp-harness/demo-live-dashboard.html" target="_blank" style="display:inline-block;padding:8px 20px;background:transparent;border:1px solid #e8b45c;color:#e8b45c;border-radius:6px;text-decoration:none;font-weight:600">Live Dashboard Demo →</a>
</div>

## Quick Start

```bash
# Export both SOC 2 and ISO 27001 evidence
kcp-harness export \
  --format both \
  --org "Your Company" \
  --from 2026-07-01 \
  --to 2026-07-07 \
  --out evidence/
```

## Output Structure

```
evidence/
  manifest.json           — generator, date range, statistics
  raw/
    sessions.json         — all sessions with event counts
    statistics.json       — aggregate metrics
  soc2/
    CC6.1-logical-access.json
    CC6.3-authorized-access.json
    CC6.6-system-boundaries.json
    CC7.2-monitoring.json
    CC8.1-change-management.json
    summary.md            — auditor-ready report
  iso27001/
    A.8.3-access-restriction.json
    A.8.4-source-code-access.json
    A.8.15-logging.json
    A.8.16-monitoring.json
    A.5.23-cloud-services.json
    summary.md            — auditor-ready report
  iso42001/                (--format iso42001)
    A.6.2.6-operation-monitoring.json
    A.6.2.8-event-logs.json
    A.9.2-responsible-use.json
    A.6.2.2-skill-invocation.json
    A.9.4-human-oversight.json
    A.6.2.4-verification-validation.json
    summary.md            — auditor-ready report
  eu-ai-act/                (--format euaiact)
    Art.12-1-automatic-logging.json
    Art.12-2-traceability.json
    Art.14-1-approval-gates.json
    Art.14-4-intervention-stop.json
    Art.14-4c-output-interpretation.json
    summary.md            — auditor-ready report
```

## SOC 2 Type II Controls

| Control | Name | Maps From |
|---------|------|-----------|
| CC6.1 | Logical Access Controls | Governed tool calls with authorization decisions |
| CC6.3 | Authorized Access | Plan-first mode pre-authorization |
| CC6.6 | System Boundaries | All tool calls with governed/pass-through classification |
| CC7.2 | Monitoring Activities | All audit events |
| CC8.1 | Change Management | Temporal drifts and plan invalidations |

## ISO 27001:2022 Annex A Controls

| Control | Name | Maps From |
|---------|------|-----------|
| A.8.3 | Information Access Restriction | Governed tool calls |
| A.8.4 | Access to Source Code | Read/Glob/Grep in governed domains |
| A.8.15 | Logging | Session lifecycle events |
| A.8.16 | Monitoring Activities | Drifts, budget exceeded, blocked access |
| A.5.23 | Cloud Services Security | Manifest signature verification |

## ISO/IEC 42001 — AI Management System (`--format iso42001`)

| Control | Name | Maps From |
|---------|------|-----------|
| A.6.2.6 | AI System Operation and Monitoring | Drifts, budget exceeded, blocked access |
| A.6.2.8 | AI System Recording of Event Logs | Session lifecycle events |
| A.9.2 | Processes for Responsible Use of AI Systems | Governed tool calls, governed skill invocations (`skill_loaded`/`skill_skipped`), procedural conformance verdicts |
| A.6.2.2 | AI System Impact — Skill Invocation Control | `skill_loaded`/`skill_skipped` — the `skill_eligibility` gate's admit/deny verdict |
| A.9.4 | Human Oversight of AI Systems | `approval_requested`/`approval_resolved` |
| A.6.2.4 | AI System Verification and Validation | `confidence_verdict` — adjudication against a threshold |

## EU AI Act (`--format euaiact`)

| Control | Name | Maps From |
|---------|------|-----------|
| Art.12(1) | Record-Keeping — Automatic Logging | Every audit event (the append-only log itself) |
| Art.12(2) | Record-Keeping — Traceability of Operation | Session lifecycle, temporal drift/plan invalidation, skill invocations |
| Art.14(1) | Human Oversight — Approval Gates | `approval_requested`/`approval_resolved` |
| Art.14(4) | Human Oversight — Intervention and Stop | Blocked calls, budget exceeded, plan invalidated, `conformance_verdict` (out-of-scope action held) |
| Art.14(4)(c) | Human Oversight — Output Interpretation | `confidence_verdict` — routed to a ticket on failure |

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `--format` | `soc2`, `iso27001`, `iso42001`, `euaiact`, or `both` (soc2 + iso27001) | `both` |
| `--org` | Organization name for report headers | — |
| `--from` | Start date filter (ISO 8601) | — |
| `--to` | End date filter (ISO 8601) | — |
| `--out` | Output directory | `evidence` |
| `--audit` | Path to audit JSONL log | from config or `.kcp-harness/audit.jsonl` |
| `--config` | Path to harness config | `harness.yaml` |

## How Mapping Works

The mapping is **deterministic**: audit events map to specific control IDs based on their `type` and `outcome` fields. No manual tagging, no AI classification — just predicate filters over structured data.

```
Audit Event (type + outcome + classification)
  │
  ├─ type === "tool_call" && governed === true  →  CC6.1, A.8.3
  ├─ mode === "plan-first" || approval_resolved →  CC6.3  (named-human authorization counts too, #33)
  ├─ type === "tool_call"                       →  CC6.6
  ├─ always                                     →  CC7.2
  ├─ type === "temporal_drift"                  →  CC8.1, A.8.16
  ├─ approval_requested || confidence_verdict   →  A.8.16 (held/adjudicated — pass or fail, #33)
  ├─ toolCall.name in [Read, Glob, Grep]        →  A.8.4
  ├─ type in [session_start, session_end]       →  A.8.15
  └─ signature !== undefined                    →  A.5.23
```

## Programmatic API

```typescript
import { exportEvidence } from "kcp-harness";

const result = await exportEvidence({
  auditPath: ".kcp-harness/audit.jsonl",
  outputDir: "evidence",
  format: "both",
  organization: "Acme Corp",
  dateRange: { from: "2026-07-01", to: "2026-07-07" },
});

console.log(`Exported ${result.files.length} files`);
console.log(`${result.summary.events} events, ${result.summary.sessions} sessions`);
```

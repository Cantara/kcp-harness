# Configuration

The harness is configured via `harness.yaml` in your project root. Create one with `kcp-harness init`.

## Full Reference

```yaml
version: "1.0"

governance:
  domains:
    - manifest: "./knowledge.yaml"    # Path to knowledge manifest
      paths:                           # File paths governed by this manifest
        - "docs/"
        - "src/models/"
      urls:                            # URL prefixes governed by this manifest
        - "https://docs.example.com/"
      tools:                           # Custom tool names to govern
        - "custom_knowledge_tool"

  policy:
    fail_closed: true          # Block access when governance can't verify (default: true)
    audit_all: true            # Log pass-through calls too (default: true)
    max_units: 5               # Maximum knowledge units per plan
    strict: false              # Strict mode — reject low-relevance units
    budget:                    # Monetary budget ceiling
      amount: 1.00
      currency: USDC
    context_budget: 50000      # Token budget ceiling
    env: prod                  # Environment (affects temporal gates)

  confidence:                  # Post-synthesis confidence gate (harness_assess)
    threshold: 0.7             # Pass/fail line, 0..1 — callers may tighten, never loosen
    severity: critical         # Label recorded on verdicts
    route_to_role: account-owner  # Route failed verdicts to this approval role
    expires_after: 72h         # TTL for routed tickets
    policy_ref: POL-9.1        # Policy citation carried as ticket evidence

  approvals:                   # Human-approval gates
    provider: file             # Ticket store: file (persisted) or memory
    dir: .kcp-harness/approvals
    require_signed_resolutions: false  # true: an unsigned/invalid --private-key resolution
                                        # fails closed — see api/cli.md `approvals approve`
    trusted_keys:               # Optional. Reviewer public keys (paths or inline PEM/base64/
      - ./keys/kari.pub          # hex). When set, a signature must verify against one of these
                                  # to bind it to a named identity; when omitted, the signature's
                                  # own embedded key is used (integrity only, not identity).
    rules:
      - match:                 # Absent criteria match everything; present ones AND together
          tools: [Write, Edit]
          paths: [records/]
        required_role: account-owner
        expires_after: 72h     # Unresolved tickets expire (fail-closed)
        policy_ref: POL-7.2

downstream:
  - name: "filesystem"         # Downstream MCP server name
    command: "npx"             # Command to launch
    args:                      # Arguments
      - "-y"
      - "@modelcontextprotocol/server-filesystem"
      - "."

audit:
  path: ".kcp-harness/audit.jsonl"   # Audit log path
```

## Governed Domains

Each domain maps a `knowledge.yaml` manifest to the paths, URLs, and tools it governs. When a tool call targets a governed path, the harness routes it through the manifest's 13-gate cascade.

You can have multiple domains:

```yaml
governance:
  domains:
    - manifest: "./docs/knowledge.yaml"
      paths: ["docs/"]
    - manifest: "./api/knowledge.yaml"
      paths: ["src/api/"]
      urls: ["https://api.example.com/"]
```

## Policy

| Field | Type | Default | Description |
|---|---|---|---|
| `fail_closed` | boolean | `true` | Block ungoverned access to governed paths |
| `audit_all` | boolean | `true` | Log pass-through (non-governed) tool calls |
| `max_units` | number | `5` | Maximum knowledge units per plan |
| `strict` | boolean | `false` | Reject units below relevance threshold |
| `budget` | object | — | Monetary budget ceiling (`amount` + `currency`) |
| `context_budget` | number | — | Token budget ceiling |
| `env` | string | — | Environment name (affects temporal gates) |

## Human-Approval Gates

`governance.approvals` holds calls for a **named human** — no matter what the automated
governance paths would decide. See [Governance Model](/guide/governance#human-approval-gates)
for the state machine and invariants.

| Field | Type | Description |
|---|---|---|
| `provider` | `file` \| `memory` | Ticket store. `file` (default) persists to `dir` and survives restarts |
| `dir` | string | Store directory (default `.kcp-harness/approvals`) |
| `rules[].match.tools` | string[] | Tool names the rule applies to (absent = all) |
| `rules[].match.paths` | string[] | Governed path prefixes (absent = all) |
| `rules[].required_role` | string | Role that must approve — required |
| `rules[].expires_after` | duration | Ticket TTL (`30m`, `72h`, `7d`); expired = fail-closed |
| `rules[].policy_ref` | string | Policy citation carried as ticket evidence |

Approval requirements are **org policy, not knowledge provenance** — they live here in
`harness.yaml`, never in the (signed) `knowledge.yaml`.

## Confidence Gate

`governance.confidence` configures the [`harness_assess`](/api/mcp-tools#harness-assess) tool.

| Field | Type | Description |
|---|---|---|
| `threshold` | number | Pass/fail line, 0..1. A caller-supplied threshold can tighten this but never loosen it |
| `severity` | string | Label recorded on verdicts (e.g. `critical`) |
| `route_to_role` | string | When set (and approvals are configured), failed verdicts open an approval ticket for this role |
| `expires_after` | duration | TTL for routed tickets |
| `policy_ref` | string | Policy citation carried as ticket evidence |

## Audit

The audit log is an append-only JSONL file. Each line is a self-contained event. See [Audit Log](/api/audit) for the full event schema.

## Environment Variables

| Variable | Description |
|---|---|
| `KCP_HARNESS_CONFIG` | Override config file path (default: `harness.yaml`) |
| `KCP_HARNESS_AUDIT` | Override audit log path |
| `ANTHROPIC_API_KEY` | Required if kcp-agent needs Claude API access |

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

## Audit

The audit log is an append-only JSONL file. Each line is a self-contained event. See [Audit Log](/api/audit) for the full event schema.

## Environment Variables

| Variable | Description |
|---|---|
| `KCP_HARNESS_CONFIG` | Override config file path (default: `harness.yaml`) |
| `KCP_HARNESS_AUDIT` | Override audit log path |
| `ANTHROPIC_API_KEY` | Required if kcp-agent needs Claude API access |

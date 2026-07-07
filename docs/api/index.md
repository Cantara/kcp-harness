# API Reference

KCP Harness exposes three interfaces:

1. **CLI** — command-line interface for setup, validation, and serving
2. **MCP Tools** — governance tools available to agents via the MCP protocol
3. **Programmatic API** — TypeScript/JavaScript API for embedding

## Quick Reference

### CLI Commands

| Command | Description |
|---|---|
| `kcp-harness serve` | Start the MCP compliance proxy |
| `kcp-harness init` | Create a `harness.yaml` template |
| `kcp-harness check` | Validate configuration |
| `kcp-harness integrate <agent>` | Generate agent integration files |

[Full CLI reference →](./cli)

### MCP Tools

| Tool | Description |
|---|---|
| `kcp_plan` | Deterministic load plan (no content) |
| `kcp_load` | Plan + load eligible unit content |
| `kcp_trace` | 13-gate decision trace |
| `harness_status` | Current governance state |
| `harness_session` | Session info |
| `harness_budget` | Session spend tracking |
| `harness_temporal_check` | Plan drift detection |

[Full MCP tools reference →](./mcp-tools)

### Compliance Artifacts

| Artifact | Format | Description |
|---|---|---|
| [Audit log](./audit) | JSONL | Append-only event log |
| [Budget ledger](./budget) | In-memory + events | Itemized spend tracking |
| [Temporal drift](./temporal) | Events | Plan validity over time |

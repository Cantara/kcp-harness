# Quick Start

Get deterministic knowledge governance running in 5 minutes.

## 1. Initialize the harness config

```bash
kcp-harness init
```

This creates `harness.yaml` in your project root:

```yaml
version: "1.0"

governance:
  domains:
    - manifest: "./knowledge.yaml"
      paths:
        - "docs/"
        - "src/"

  policy:
    fail_closed: true
    audit_all: true
    max_units: 5
    strict: false

audit:
  path: ".kcp-harness/audit.jsonl"
```

## 2. Generate agent integration files

Pick your agent:

```bash
# Claude Code
kcp-harness integrate claude-code

# Cursor
kcp-harness integrate cursor

# GitHub Copilot
kcp-harness integrate copilot

# All agents at once (dry-run first)
kcp-harness integrate claude-code --dry-run
```

This generates the MCP config and rules file for your agent. See [Agent Integrations](/agents/) for agent-specific setup.

## 3. Validate the config

```bash
kcp-harness check
```

## 4. Start coding

Your agent now routes knowledge access through the harness. When it tries to read a governed file:

1. The harness classifies the tool call as knowledge-navigation
2. Runs the 13-gate cascade via kcp-agent
3. Returns content only if all gates pass
4. Logs the decision to the audit log

## What happens under the hood

```
You: "Explain the authentication flow"

Agent: calls kcp_plan(task="explain auth flow", manifest="./knowledge.yaml")
  → Harness: runs 13-gate cascade
  → Returns: plan with 3 eligible units

Agent: calls kcp_load(task="explain auth flow", manifest="./knowledge.yaml")
  → Harness: loads eligible units, tracks budget
  → Returns: unit content + metadata

Agent: uses loaded knowledge to answer your question
  → Harness: logs decision trace to audit.jsonl
```

## Next Steps

- [Configuration](./configuration) — customize `harness.yaml`
- [Architecture](./architecture) — understand the proxy pipeline
- [MCP Tools](../api/mcp-tools) — all available governance tools

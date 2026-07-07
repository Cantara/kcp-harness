# Crush

Crush is a multi-model agent (30+ models) with native MCP support and a **PrepareStep** pattern that lets you pre-load knowledge before the main task runs.

## Setup

```bash
kcp-harness integrate crush
```

This generates:

### `crush.json`

```json
{
  "mcpServers": {
    "kcp-harness": {
      "command": "npx",
      "args": ["kcp-harness", "serve"]
    }
  },
  "prepareSteps": [
    {
      "name": "load-knowledge",
      "description": "Pre-load governed knowledge via KCP harness",
      "tool": "kcp_plan",
      "arguments": {
        "task": "{{task}}",
        "manifest": "./knowledge.yaml"
      }
    }
  ]
}
```

## PrepareStep Pattern

The `prepareSteps` configuration runs `kcp_plan` **before each task**. This ensures:

1. The harness has an approved plan before Crush accesses any files
2. Plan-first mode kicks in for subsequent reads (fast path)
3. Budget is tracked from the first tool call

The `{{task}}` placeholder is replaced with Crush's current task description.

## Why kcp_plan (not kcp_load)?

The PrepareStep uses `kcp_plan` (not `kcp_load`) because:

- `kcp_plan` is lightweight — it returns the plan without loading content
- The plan is cached in the harness session
- Subsequent `Read` calls to governed paths use the cached plan (plan-first fast path)
- This avoids loading all knowledge upfront when only some units may be needed

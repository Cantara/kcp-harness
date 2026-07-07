# OpenClaw

OpenClaw is an open-source multi-channel agent with a plugin hooks system. KCP Harness integrates via two hooks: `before_prompt_build` and `before_agent_finalize`.

## Setup

```bash
kcp-harness integrate openclaw
```

This generates:

### `openclaw.json`

```json
{
  "mcpServers": {
    "kcp-harness": {
      "command": "npx",
      "args": ["kcp-harness", "serve"]
    }
  },
  "plugins": {
    "kcp-governance": {
      "hooks": {
        "before_prompt_build": {
          "tool": "kcp_load",
          "arguments": {
            "task": "{{task}}",
            "manifest": "./knowledge.yaml"
          },
          "description": "Load governed knowledge before prompt assembly"
        },
        "before_agent_finalize": {
          "tool": "kcp_trace",
          "arguments": {
            "task": "{{task}}",
            "manifest": "./knowledge.yaml"
          },
          "description": "Decision trace for audit trail before finalizing"
        }
      }
    }
  }
}
```

## Plugin Hooks

### `before_prompt_build`

Calls `kcp_load` to inject governed knowledge into the prompt **before** it's assembled. This ensures the model sees governed knowledge as part of its context, not as a separate tool call result.

### `before_agent_finalize`

Calls `kcp_trace` **after** the agent produces its response, creating a 13-gate decision trace for the audit log. This provides a compliance record of what knowledge was available and why.

## The `{{task}}` Placeholder

Both hooks use `{{task}}`, which OpenClaw replaces with the current task description. This ensures the harness plans knowledge selection based on the actual task.

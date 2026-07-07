// OpenClaw integration — openclaw.json + plugin hooks documentation.
//
// OpenClaw is an open-source multi-channel agent with plugin hooks:
//   - before_prompt_build: inject kcp-loaded knowledge into prompt
//   - before_agent_finalize: post-synthesis claim verification
//
// OpenClaw's MCP support uses the standard mcpServers key.

import type { IntegrationOutput, IntegrationOptions } from "./types.js";
import { harnessServerEntry, governedPathsBlock, manifestRef } from "./generate.js";

export function generateOpenClaw(options: IntegrationOptions): IntegrationOutput {
  const server = harnessServerEntry(options);
  const manifest = manifestRef(options);

  const openclawJson: IntegrationOutput["files"][0] = {
    path: "openclaw.json",
    content: JSON.stringify(
      {
        mcpServers: {
          "kcp-harness": server,
        },
        plugins: {
          "kcp-governance": {
            hooks: {
              before_prompt_build: {
                tool: "kcp_load",
                arguments: {
                  task: "{{task}}",
                  manifest: manifest,
                },
                description:
                  "Load governed knowledge via KCP harness before prompt assembly",
              },
              before_agent_finalize: {
                tool: "kcp_trace",
                arguments: {
                  task: "{{task}}",
                  manifest: manifest,
                },
                description:
                  "Run decision trace for audit trail before finalizing agent response",
              },
            },
          },
        },
      },
      null,
      2,
    ) + "\n",
    commitToGit: true,
    description: "OpenClaw MCP config with plugin hooks for knowledge governance",
  };

  return {
    agent: "openclaw",
    name: "OpenClaw",
    files: [openclawJson],
    instructions: `## OpenClaw Integration

**Setup:**
1. Place \`openclaw.json\` in your project root
2. OpenClaw will auto-discover the kcp-harness MCP server

**Plugin Hooks:**
- \`before_prompt_build\` — calls \`kcp_load\` to inject governed knowledge before the prompt is assembled. This ensures the model sees governed knowledge as part of its context, not as a separate tool call.
- \`before_agent_finalize\` — calls \`kcp_trace\` after the agent produces its response, creating a decision trace for the audit log.

The \`{{task}}\` placeholder is replaced with OpenClaw's current task description.

**Available MCP Tools:**
- \`kcp_plan\` — deterministic load plan
- \`kcp_load\` — plan + load content
- \`kcp_trace\` — 13-gate decision trace
- \`harness_budget\` — session spend tracking
- \`harness_temporal_check\` — plan drift detection`,
  };
}

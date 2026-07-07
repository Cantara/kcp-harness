// Crush integration — MCP config + PrepareStep pattern documentation.
//
// Crush is a multi-model agent (30+ models) with native MCP support.
// The PrepareStep pattern lets Crush pre-load knowledge before the
// main task runs, ensuring governed knowledge is available in context.

import type { IntegrationOutput, IntegrationOptions } from "./types.js";
import { harnessServerEntry, governedPathsBlock, manifestRef } from "./generate.js";

export function generateCrush(options: IntegrationOptions): IntegrationOutput {
  const server = harnessServerEntry(options);
  const manifest = manifestRef(options);

  const crushJson: IntegrationOutput["files"][0] = {
    path: "crush.json",
    content: JSON.stringify(
      {
        mcpServers: {
          "kcp-harness": server,
        },
        prepareSteps: [
          {
            name: "load-knowledge",
            description: "Pre-load governed knowledge via KCP harness",
            tool: "kcp_plan",
            arguments: {
              task: "{{task}}",
              manifest: manifest,
            },
          },
        ],
      },
      null,
      2,
    ) + "\n",
    commitToGit: true,
    description: "Crush MCP config with PrepareStep for knowledge pre-loading",
  };

  return {
    agent: "crush",
    name: "Crush",
    files: [crushJson],
    instructions: `## Crush Integration

**Setup:**
1. Place \`crush.json\` in your project root
2. Crush will auto-discover the kcp-harness MCP server

The \`prepareSteps\` configuration runs \`kcp_plan\` before each task, pre-loading the governance plan. This ensures:
- The harness has an approved plan before Crush accesses any files
- Plan-first mode kicks in for subsequent reads (fast path)
- Budget is tracked from the first tool call

The \`{{task}}\` placeholder is replaced with Crush's current task description.`,
  };
}

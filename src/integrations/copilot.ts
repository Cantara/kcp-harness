// GitHub Copilot integration — .vscode/mcp.json + .github/copilot-instructions.md
//
// IMPORTANT: VS Code Copilot uses "servers" as the top-level key,
// NOT "mcpServers" like every other agent. MCP tools are only
// available in Agent mode.

import type { IntegrationOutput, IntegrationOptions } from "./types.js";
import { harnessServerEntry, governedPathsBlock, manifestRef } from "./generate.js";

export function generateCopilot(options: IntegrationOptions): IntegrationOutput {
  const server = harnessServerEntry(options);
  const manifest = manifestRef(options);

  // VS Code uses "servers" (not "mcpServers")
  const vscodeMcp: IntegrationOutput["files"][0] = {
    path: ".vscode/mcp.json",
    content: JSON.stringify(
      {
        servers: {
          "kcp-harness": {
            type: "stdio",
            ...server,
          },
        },
      },
      null,
      2,
    ) + "\n",
    commitToGit: true,
    description: "VS Code MCP config — note: uses 'servers' key (not 'mcpServers'). Agent mode only.",
  };

  const instructions: IntegrationOutput["files"][0] = {
    path: ".github/copilot-instructions.md",
    content: `# Knowledge Governance

This project uses the KCP Compliance Harness for deterministic knowledge governance.

## Governed Paths

${governedPathsBlock(options)}

These paths are governed by \`${manifest}\`. Use the kcp-harness MCP server to access them.

## Rules

1. Always call \`kcp_plan\` or \`kcp_load\` (via the kcp-harness MCP server) before reading governed files
2. The harness enforces budget ceilings, temporal validity, and access control
3. Use \`harness_status\` to check governance state
4. Direct file reads of governed paths may be blocked by the governance layer

## Available MCP Tools

- \`kcp_plan\` — deterministic load plan
- \`kcp_load\` — plan + load content
- \`kcp_trace\` — decision trace (13-gate cascade)
- \`harness_budget\` — session spend tracking
- \`harness_temporal_check\` — plan drift detection
`,
    commitToGit: true,
    description: "GitHub Copilot instructions — governance rules",
  };

  return {
    agent: "copilot",
    name: "GitHub Copilot",
    files: [vscodeMcp, instructions],
    instructions: `## GitHub Copilot Integration

**IMPORTANT:** VS Code Copilot uses \`"servers"\` as the top-level key in \`.vscode/mcp.json\` — NOT \`"mcpServers"\`. MCP tools are only available in **Agent mode** (not Ask or Edit mode).

**Setup:**
1. Place \`.vscode/mcp.json\` in your project root
2. Place \`.github/copilot-instructions.md\` in your project root
3. In VS Code, switch Copilot Chat to Agent mode to access kcp-harness tools

For Copilot CLI, add to \`~/.copilot/mcp-config.json\` instead (uses \`mcpServers\` key + \`tools: ["*"]\`).`,
  };
}

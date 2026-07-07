// Windsurf (Codeium) integration — global MCP config + .windsurfrules

import type { IntegrationOutput, IntegrationOptions } from "./types.js";
import { harnessServerEntry, governedPathsBlock, manifestRef } from "./generate.js";

export function generateWindsurf(options: IntegrationOptions): IntegrationOutput {
  const server = harnessServerEntry(options);
  const manifest = manifestRef(options);

  // Windsurf uses a GLOBAL config — we generate the snippet to add
  const mcpSnippet: IntegrationOutput["files"][0] = {
    path: "windsurf-mcp-snippet.json",
    content: JSON.stringify(
      {
        "kcp-harness": server,
      },
      null,
      2,
    ) + "\n",
    commitToGit: false,
    description: "MCP snippet to add to ~/.codeium/windsurf/mcp_config.json (global config)",
  };

  const rulesFile: IntegrationOutput["files"][0] = {
    path: ".windsurfrules",
    content: `# KCP Knowledge Governance

This project uses the KCP Compliance Harness for deterministic knowledge access control.

## Governed Paths

${governedPathsBlock(options)}

These paths are governed by \`${manifest}\`.

## Rules

1. Always call \`kcp_plan\` or \`kcp_load\` (via the kcp-harness MCP server) before reading governed files
2. The harness intercepts tool calls and routes knowledge access through the kcp-agent planner
3. Budget and temporal governance are enforced automatically
4. Use \`harness_status\` to check the current governance state

## Available MCP Tools

- \`kcp_plan\` — deterministic load plan (no content)
- \`kcp_load\` — plan + load eligible unit content
- \`kcp_trace\` — 13-gate decision trace
- \`harness_budget\` — session spend tracking
- \`harness_temporal_check\` — plan drift detection
`,
    commitToGit: true,
    description: "Windsurf rules — governance instructions for Cascade",
  };

  return {
    agent: "windsurf",
    name: "Windsurf",
    files: [mcpSnippet, rulesFile],
    instructions: `## Windsurf Integration

Windsurf uses a **global** MCP config (not per-project).

**Setup:**
1. Add the kcp-harness entry to \`~/.codeium/windsurf/mcp_config.json\`:
   \`\`\`json
   {
     "mcpServers": {
       "kcp-harness": { ... }  // ← merge from windsurf-mcp-snippet.json
     }
   }
   \`\`\`
2. Place \`.windsurfrules\` in your project root
3. Restart Windsurf

The \`.windsurfrules\` file instructs Cascade to use kcp_load for governed knowledge access.`,
  };
}

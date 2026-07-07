// Cursor integration — .cursor/mcp.json + .cursor/rules/kcp-governance.mdc

import type { IntegrationOutput, IntegrationOptions } from "./types.js";
import { harnessServerEntry, governedPathsBlock, manifestRef } from "./generate.js";

export function generateCursor(options: IntegrationOptions): IntegrationOutput {
  const server = harnessServerEntry(options);
  const manifest = manifestRef(options);
  const paths = options.paths ?? ["docs/", "src/"];

  const mcpJson: IntegrationOutput["files"][0] = {
    path: ".cursor/mcp.json",
    content: JSON.stringify(
      {
        mcpServers: {
          "kcp-harness": server,
        },
      },
      null,
      2,
    ) + "\n",
    commitToGit: true,
    description: "Cursor MCP config — adds kcp-harness as governance proxy",
  };

  const rulesFile: IntegrationOutput["files"][0] = {
    path: ".cursor/rules/kcp-governance.mdc",
    content: `---
globs: [${paths.map((p) => `"${p}**"`).join(", ")}]
alwaysApply: true
---

# KCP Knowledge Governance

This project enforces deterministic knowledge governance via the KCP Compliance Harness.

## Governed Paths

${governedPathsBlock(options)}

These paths are governed by \`${manifest}\`. Access is controlled by the kcp-agent planner (13-gate cascade).

## Required Workflow

1. **Before reading governed files**, call \`kcp_plan\` or \`kcp_load\` via the kcp-harness MCP server
2. The harness will classify your tool calls and route knowledge-navigation through the planner
3. Direct file reads of governed paths will be blocked if no approved plan exists

## Available Tools (via kcp-harness MCP server)

- \`kcp_plan\` — produce a load plan without loading content
- \`kcp_load\` — plan + load content of eligible units
- \`kcp_trace\` — see the 13-gate decision trace
- \`harness_status\` — check governance state
- \`harness_budget\` — check remaining budget
- \`harness_temporal_check\` — verify plan temporal validity
`,
    commitToGit: true,
    description: "Cursor rules — governance instructions scoped to governed paths",
  };

  return {
    agent: "cursor",
    name: "Cursor",
    files: [mcpJson, rulesFile],
    instructions: `## Cursor Integration

1. Place \`.cursor/mcp.json\` in your project root — Cursor loads MCP servers from here
2. Place \`.cursor/rules/kcp-governance.mdc\` — Cursor applies these rules when editing governed paths

**Setup:** Copy the generated files to your project root. Restart Cursor to pick up the MCP server.

The \`.mdc\` file uses glob-scoped rules so governance instructions only activate when working in governed directories.`,
  };
}

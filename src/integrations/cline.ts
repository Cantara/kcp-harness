// Cline integration — MCP settings snippet + .clinerules

import type { IntegrationOutput, IntegrationOptions } from "./types.js";
import { harnessServerEntry, governedPathsBlock, manifestRef } from "./generate.js";

export function generateCline(options: IntegrationOptions): IntegrationOutput {
  const server = harnessServerEntry(options);
  const manifest = manifestRef(options);

  const mcpSnippet: IntegrationOutput["files"][0] = {
    path: "cline-mcp-snippet.json",
    content: JSON.stringify(
      {
        "kcp-harness": {
          ...server,
          disabled: false,
          autoApprove: [
            "kcp_plan",
            "kcp_trace",
            "harness_status",
            "harness_session",
            "harness_budget",
            "harness_temporal_check",
          ],
        },
      },
      null,
      2,
    ) + "\n",
    commitToGit: false,
    description: "MCP snippet to add via Cline's MCP Servers settings UI",
  };

  const rulesFile: IntegrationOutput["files"][0] = {
    path: ".clinerules",
    content: `# KCP Knowledge Governance

This project uses the KCP Compliance Harness for deterministic knowledge governance.

## Governed Paths

${governedPathsBlock(options)}

Governed by: \`${manifest}\`

## Mandatory Rules

1. **Always call \`kcp_load\`** before reading files in governed paths
2. Call \`kcp_plan\` first to inspect the load plan
3. The harness blocks ungoverned access to governed paths (fail-closed)
4. Budget and temporal governance are enforced automatically

## Available MCP Tools (kcp-harness server)

- \`kcp_plan\` — deterministic load plan
- \`kcp_load\` — plan + load content
- \`kcp_trace\` — 13-gate decision trace
- \`kcp_validate\` — lint knowledge.yaml
- \`harness_status\` — governance state
- \`harness_budget\` — spend tracking
- \`harness_temporal_check\` — drift detection
`,
    commitToGit: true,
    description: "Cline rules — governance instructions",
  };

  return {
    agent: "cline",
    name: "Cline",
    files: [mcpSnippet, rulesFile],
    instructions: `## Cline Integration

**Setup:**
1. Open Cline sidebar > MCP Servers tab > gear icon
2. Add the kcp-harness entry from \`cline-mcp-snippet.json\`
3. Place \`.clinerules\` in your project root

The \`autoApprove\` list lets Cline call read-only governance tools without confirmation prompts. Write operations (kcp_load) still require approval.`,
  };
}

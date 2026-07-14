// Pi integration — project-local MCP config plus an agent operating skill.

import type { IntegrationOutput, IntegrationFile, IntegrationOptions } from "./types.js";
import { governedPathsBlock, harnessServerEntry, manifestRef } from "./generate.js";

export function generatePi(options: IntegrationOptions): IntegrationOutput {
  const server = harnessServerEntry(options);
  const manifest = manifestRef(options);
  const mcpJson: IntegrationFile = {
    path: ".pi/mcp.json",
    content: JSON.stringify(
      {
        settings: { toolPrefix: "server", directTools: false },
        mcpServers: { "kcp-harness": { ...server, lifecycle: "lazy" } },
      },
      null,
      2,
    ) + "\n",
    commitToGit: true,
    description: "Pi MCP config — connects Pi to the lazy kcp-harness governance proxy",
  };

  const skill: IntegrationFile = {
    path: ".pi/skills/kcp-harness/SKILL.md",
    content: `---
name: kcp-harness
description: Use the kcp-harness MCP proxy for governed project knowledge. Load before reading governed paths or making architecture decisions.
---

# KCP Harness for Pi

This project uses kcp-harness to govern knowledge access through \`knowledge.yaml\`.

## Governed paths

${governedPathsBlock(options)}

## Agent workflow

1. Call \`kcp_plan\` with the task and manifest \`${manifest}\`.
2. Call \`kcp_load\` to load only the approved units.
3. Use \`harness_status\` and \`harness_budget\` when the task has governance or budget implications.
4. Treat plan and audit metadata as evidence; do not bypass the harness with direct reads of governed paths.
5. Re-check temporal validity with \`harness_temporal_check\` before relying on an old plan.

The harness owns governance. This skill teaches the agent how to use it; it does not reimplement planner gates.
`,
    commitToGit: true,
    description: "Pi skill — instructs the agent to use kcp-harness plan/load and diagnostics",
  };

  return {
    agent: "pi",
    name: "Pi",
    files: [mcpJson, skill],
    instructions: `## Pi Integration

1. The .pi/mcp.json registers kcp-harness as a lazy MCP server.
2. The .pi/skills/kcp-harness/SKILL.md teaches Pi to call kcp_plan and kcp_load for governed knowledge.
3. Keep directTools disabled by default to avoid flattening the provider's full tool surface.

Review generated files before committing them. Regenerate with \`--dry-run\` to inspect output without writing.
`,
  };
}

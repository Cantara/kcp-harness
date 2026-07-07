// Continue integration — .continue/mcpServers/kcp-harness.yaml

import type { IntegrationOutput, IntegrationOptions } from "./types.js";
import { manifestRef } from "./generate.js";

export function generateContinue(options: IntegrationOptions): IntegrationOutput {
  const manifest = manifestRef(options);
  const harnessCmd = options.harnessCommand ?? "npx";
  const harnessArgs = options.harnessArgs ?? [
    "kcp-harness", "serve",
    ...(options.harnessConfig ? ["--config", options.harnessConfig] : []),
  ];

  const mcpYaml: IntegrationOutput["files"][0] = {
    path: ".continue/mcpServers/kcp-harness.yaml",
    content: `name: KCP Compliance Harness
version: 0.1.0
schema: v1
mcpServers:
  - name: kcp-harness
    command: ${harnessCmd}
    args:
${harnessArgs.map((a) => `      - "${a}"`).join("\n")}
`,
    commitToGit: true,
    description: "Continue MCP server config for kcp-harness",
  };

  return {
    agent: "continue",
    name: "Continue",
    files: [mcpYaml],
    instructions: `## Continue Integration

**Setup:**
1. Place \`.continue/mcpServers/kcp-harness.yaml\` in your project root
2. Restart Continue

Continue loads MCP servers from the \`.continue/mcpServers/\` directory automatically.
Use agent mode to access kcp-harness tools (\`kcp_plan\`, \`kcp_load\`, etc.).

Note: Continue uses YAML format (not JSON) for MCP server configs in the directory-based approach.`,
  };
}

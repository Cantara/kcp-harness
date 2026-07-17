// Claude Code integration — MCP config + PreToolUse hooks + CLAUDE.md instructions.

import type { IntegrationOutput, IntegrationFile, IntegrationOptions } from "./types.js";
import { harnessServerEntry, governedPathsBlock, manifestRef } from "./generate.js";

export function generateClaudeCode(options: IntegrationOptions): IntegrationOutput {
  const server = harnessServerEntry(options);
  const manifest = manifestRef(options);
  const paths = options.paths ?? ["docs/", "src/"];

  const mcpJson: IntegrationFile = {
    path: ".mcp.json",
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
    description: "MCP server config — adds kcp-harness as a governance proxy",
  };

  const hooksJson: IntegrationFile = {
    path: ".claude/settings.json",
    content: JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Read|Edit|Write|Glob|Grep",
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: ["-e", `
const deny = (reason) => {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
};
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    // Fail-closed: an unreadable payload means we cannot prove the target is
    // ungoverned, so we must not let it through.
    deny("kcp-harness: could not parse PreToolUse input — failing closed");
    return;
  }
  const args = input.tool_input || {};
  const path = args.file_path || args.path || '';
  const governed = ${JSON.stringify(paths)}.some(p => path.startsWith(p) || path.includes('/' + p));
  if (governed) {
    deny("Use kcp_load to access governed knowledge at " + path);
  }
});
                  `.trim()],
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n",
    commitToGit: true,
    description: "PreToolUse hooks — block direct reads of governed paths, require kcp_load",
  };

  const claudeMd: IntegrationFile = {
    path: "CLAUDE.md",
    content: `# Knowledge Governance

This project uses the KCP Compliance Harness for deterministic knowledge governance.

## Governed Paths

The following paths are governed by \`${manifest}\`:
${governedPathsBlock(options)}

## Rules

1. **Always use \`kcp_load\`** before reading governed files — never read them directly
2. Call \`kcp_plan\` first to see what units are available for your task
3. The harness enforces budget ceilings and temporal validity automatically
4. Use \`harness_status\` to check the current governance state
5. Use \`harness_budget\` to check remaining budget
6. Use \`harness_temporal_check\` to verify plans are still valid

## Example Workflow

\`\`\`
1. kcp_plan  task="understand the API" manifest="${manifest}"
2. kcp_load  task="understand the API" manifest="${manifest}"
3. Read governed files through the harness (auto-governed)
\`\`\`
`,
    commitToGit: true,
    description: "CLAUDE.md — instructions for using governed knowledge",
  };

  return {
    agent: "claude-code",
    name: "Claude Code",
    files: [mcpJson, hooksJson, claudeMd],
    instructions: `## Claude Code Integration

1. The \`.mcp.json\` registers kcp-harness as an MCP server
2. The \`.claude/settings.json\` adds PreToolUse hooks that block direct reads of governed paths
3. The \`CLAUDE.md\` instructs the agent to use kcp_load for knowledge access

**Setup:**
\`\`\`bash
# Or add manually:
claude mcp add --scope project kcp-harness -- npx kcp-harness serve
\`\`\`

The hooks enforce governance at the tool level — even if the model tries to \`Read\` a governed path directly, the hook blocks it and redirects to kcp_load.`,
  };
}

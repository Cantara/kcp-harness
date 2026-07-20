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
              matcher: "Bash|Read|Edit|Write|Glob|Grep",
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
// Path matching mirrors src/classifier.ts so native file tools can't slip past
// with a Bash command, a Glob/Grep pattern, a case variant, or a backslash
// separator. Plain string ops only — this runs as an inline node script.
const BS = String.fromCharCode(92);
const GOV = ${JSON.stringify(paths)}.map((p) => {
  let b = String(p).split(BS).join("/").toLowerCase();
  while (b.slice(-1) === "/") b = b.slice(0, -1);
  return b;
}).filter(Boolean);
const norm = (p) => {
  let n = String(p == null ? "" : p).split(BS).join("/");
  while (n.indexOf("//") >= 0) n = n.split("//").join("/");
  if (n.slice(0, 2) === "./") n = n.slice(2);
  const parts = n.split("/"), out = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (s === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); }
    else if (s !== "." && s !== "") out.push(s);
  }
  return out.join("/").toLowerCase();
};
const isGoverned = (t) => {
  if (!t) return false;
  const n = norm(t);
  return GOV.some((b) => n === b || n.indexOf(b + "/") === 0 || n.indexOf("/" + b + "/") >= 0);
};
const globPrefix = (pattern) => {
  const s = String(pattern || "");
  let idx = -1;
  for (let i = 0; i < s.length; i++) { if ("*?[{".indexOf(s[i]) >= 0) { idx = i; break; } }
  if (idx <= 0) return "";
  const pre = s.slice(0, idx), ls = pre.lastIndexOf("/");
  if (ls > 0) return pre.slice(0, ls);
  if (pre.length > 0 && pre.indexOf(".") < 0) { let r = pre; while (r.slice(-1) === "/") r = r.slice(0, -1); return r; }
  return "";
};
const tokens = (cmd) => {
  const s = String(cmd || ""), seps = " " + String.fromCharCode(9) + String.fromCharCode(10) + ";|&<>()" + String.fromCharCode(34) + String.fromCharCode(39);
  let cur = "", out = [];
  for (let i = 0; i < s.length; i++) { const ch = s[i]; if (seps.indexOf(ch) >= 0) { if (cur) { out.push(cur); cur = ""; } } else cur += ch; }
  if (cur) out.push(cur);
  return out;
};
const bashTarget = (cmd) => {
  const toks = tokens(cmd);
  const readCmds = ["cat","head","tail","less","more","vi","vim","nano","code","cp","mv","ln","tar","zip","scp","rsync"];
  for (let i = 0; i < toks.length; i++) {
    if (readCmds.indexOf(toks[i]) >= 0) {
      for (let j = i + 1; j < toks.length; j++) { if (toks[j][0] !== "-" && isGoverned(toks[j])) return toks[j]; }
    }
  }
  if (String(cmd || "").indexOf(">") >= 0) { for (let j = 0; j < toks.length; j++) { if (isGoverned(toks[j])) return toks[j]; } }
  return "";
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
  const tool = input.tool_name || "";
  const a = input.tool_input || {};
  let targets;
  if (tool === "Glob" || tool === "Grep") targets = [a.path || "", globPrefix(a.pattern)];
  else if (tool === "Bash") targets = [bashTarget(a.command)];
  else targets = [a.file_path || a.path || ""];
  const hit = targets.filter(Boolean).find(isGoverned);
  if (hit) {
    deny("Use kcp_load to access governed knowledge at " + hit);
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

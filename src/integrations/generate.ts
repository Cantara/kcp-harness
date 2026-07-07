// Integration generator — produce agent-specific configs from harness config.
//
// Each agent has its own MCP config format, rules file, and setup pattern.
// The generator takes a harness config and produces the files needed to
// integrate the harness with a specific agent.

import type {
  AgentTarget,
  IntegrationOutput,
  IntegrationFile,
  IntegrationOptions,
} from "./types.js";

import { generateClaudeCode } from "./claude-code.js";
import { generateCursor } from "./cursor.js";
import { generateWindsurf } from "./windsurf.js";
import { generateCline } from "./cline.js";
import { generateContinue } from "./continue.js";
import { generateCopilot } from "./copilot.js";
import { generateCrush } from "./crush.js";
import { generateOpenClaw } from "./openclaw.js";

const GENERATORS: Record<AgentTarget, (opts: IntegrationOptions) => IntegrationOutput> = {
  "claude-code": generateClaudeCode,
  cursor: generateCursor,
  windsurf: generateWindsurf,
  cline: generateCline,
  continue: generateContinue,
  copilot: generateCopilot,
  "copilot-cli": generateCopilot, // Same format, different path
  crush: generateCrush,
  openclaw: generateOpenClaw,
};

/** Generate integration files for a specific agent. */
export function generate(agent: AgentTarget, options: IntegrationOptions = {}): IntegrationOutput {
  const gen = GENERATORS[agent];
  if (!gen) throw new Error(`unsupported agent: ${agent}`);
  return gen(options);
}

/** Generate integration files for all agents. */
export function generateAll(options: IntegrationOptions = {}): IntegrationOutput[] {
  return Object.keys(GENERATORS).map((agent) =>
    generate(agent as AgentTarget, options),
  );
}

/** List all supported agent targets. */
export function listAgents(): AgentTarget[] {
  return Object.keys(GENERATORS) as AgentTarget[];
}

// -- Shared helpers for generators ------------------------------------------

/** Build the MCP server entry for kcp-harness. */
export function harnessServerEntry(options: IntegrationOptions): Record<string, unknown> {
  return {
    command: options.harnessCommand ?? "npx",
    args: options.harnessArgs ?? [
      "kcp-harness",
      "serve",
      ...(options.harnessConfig ? ["--config", options.harnessConfig] : []),
    ],
  };
}

/** Build governed paths description for rules files. */
export function governedPathsBlock(options: IntegrationOptions): string {
  const paths = options.paths ?? ["docs/", "src/"];
  return paths.map((p) => `  - \`${p}\``).join("\n");
}

/** Build manifest reference for rules files. */
export function manifestRef(options: IntegrationOptions): string {
  return options.manifest ?? "./knowledge.yaml";
}

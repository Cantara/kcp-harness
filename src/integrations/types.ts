// Integration types — shared across all agent integration packages.

/** Supported agent targets for integration generation. */
export type AgentTarget =
  | "claude-code"
  | "cursor"
  | "windsurf"
  | "cline"
  | "continue"
  | "copilot"
  | "copilot-cli"
  | "crush"
  | "openclaw";

/** Integration output — generated files for a specific agent. */
export interface IntegrationOutput {
  /** Which agent this integration is for. */
  agent: AgentTarget;
  /** Display name. */
  name: string;
  /** Files to write (path → content). */
  files: IntegrationFile[];
  /** Human-readable setup instructions (markdown). */
  instructions: string;
}

/** A file to write as part of the integration. */
export interface IntegrationFile {
  /** Relative path from project root. */
  path: string;
  /** File content. */
  content: string;
  /** Whether this file should be committed to git. */
  commitToGit: boolean;
  /** Description of what this file does. */
  description: string;
}

/** Options for generating an integration. */
export interface IntegrationOptions {
  /** Path to the harness YAML config. */
  harnessConfig?: string;
  /** Governed knowledge.yaml path. */
  manifest?: string;
  /** Governed path prefixes. */
  paths?: string[];
  /** Project root (for relative path resolution). */
  projectRoot?: string;
  /** Custom harness command (default: npx kcp-harness serve). */
  harnessCommand?: string;
  /** Custom harness args. */
  harnessArgs?: string[];
}

/** Agent metadata. */
export interface AgentInfo {
  target: AgentTarget;
  name: string;
  mcpSupport: boolean;
  configFile: string;
  rulesFile?: string;
  topLevelKey: string;
  notes?: string;
}

/** Registry of all supported agents. */
export const AGENTS: Record<AgentTarget, AgentInfo> = {
  "claude-code": {
    target: "claude-code",
    name: "Claude Code",
    mcpSupport: true,
    configFile: ".mcp.json",
    rulesFile: "CLAUDE.md",
    topLevelKey: "mcpServers",
    notes: "First-class MCP + hooks (PreToolUse)",
  },
  cursor: {
    target: "cursor",
    name: "Cursor",
    mcpSupport: true,
    configFile: ".cursor/mcp.json",
    rulesFile: ".cursor/rules/kcp-governance.mdc",
    topLevelKey: "mcpServers",
  },
  windsurf: {
    target: "windsurf",
    name: "Windsurf",
    mcpSupport: true,
    configFile: "~/.codeium/windsurf/mcp_config.json",
    rulesFile: ".windsurfrules",
    topLevelKey: "mcpServers",
    notes: "Global config only (no per-project MCP file)",
  },
  cline: {
    target: "cline",
    name: "Cline",
    mcpSupport: true,
    configFile: "cline_mcp_settings.json",
    rulesFile: ".clinerules",
    topLevelKey: "mcpServers",
    notes: "Config managed via VS Code extension UI",
  },
  continue: {
    target: "continue",
    name: "Continue",
    mcpSupport: true,
    configFile: ".continue/mcpServers/kcp-harness.yaml",
    topLevelKey: "mcpServers",
  },
  copilot: {
    target: "copilot",
    name: "GitHub Copilot",
    mcpSupport: true,
    configFile: ".vscode/mcp.json",
    rulesFile: ".github/copilot-instructions.md",
    topLevelKey: "servers",
    notes: "Uses 'servers' not 'mcpServers'. Agent mode only.",
  },
  "copilot-cli": {
    target: "copilot-cli",
    name: "GitHub Copilot CLI",
    mcpSupport: true,
    configFile: "~/.copilot/mcp-config.json",
    topLevelKey: "mcpServers",
  },
  crush: {
    target: "crush",
    name: "Crush",
    mcpSupport: true,
    configFile: "crush.json",
    topLevelKey: "mcpServers",
    notes: "PrepareStep pattern for knowledge pre-loading",
  },
  openclaw: {
    target: "openclaw",
    name: "OpenClaw",
    mcpSupport: true,
    configFile: "openclaw.json",
    topLevelKey: "mcpServers",
    notes: "Plugin hooks: before_prompt_build, before_agent_finalize",
  },
};

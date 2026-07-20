import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { generate, generateAll, listAgents } from "../src/integrations/generate.js";
import { AGENTS, type AgentTarget, type IntegrationOptions } from "../src/integrations/types.js";

const DEFAULT_OPTS: IntegrationOptions = {
  manifest: "./knowledge.yaml",
  paths: ["docs/", "fragments/"],
};

describe("integration generators", () => {
  describe("listAgents", () => {
    it("returns all agent targets", () => {
      const agents = listAgents();
      expect(agents.length).toBeGreaterThanOrEqual(9);
      expect(agents).toContain("pi");
      expect(agents).toContain("claude-code");
      expect(agents).toContain("cursor");
      expect(agents).toContain("windsurf");
      expect(agents).toContain("cline");
      expect(agents).toContain("continue");
      expect(agents).toContain("copilot");
      expect(agents).toContain("copilot-cli");
      expect(agents).toContain("crush");
      expect(agents).toContain("openclaw");
    });
  });

  describe("generate — common structure", () => {
    const agents = listAgents();

    for (const agent of agents) {
      it(`${agent}: returns valid IntegrationOutput`, () => {
        const output = generate(agent, DEFAULT_OPTS);
        // copilot-cli is an alias for copilot (same generator)
        if (agent !== "copilot-cli") {
          expect(output.agent).toBe(agent);
        }
        expect(output.name).toBeTruthy();
        expect(output.files.length).toBeGreaterThan(0);
        expect(output.instructions).toBeTruthy();

        for (const file of output.files) {
          expect(file.path).toBeTruthy();
          expect(file.content).toBeTruthy();
          expect(typeof file.commitToGit).toBe("boolean");
          expect(file.description).toBeTruthy();
        }
      });
    }
  });

  describe("generateAll", () => {
    it("generates for all agents", () => {
      const all = generateAll(DEFAULT_OPTS);
      expect(all.length).toBe(listAgents().length);
    });
  });

  describe("generate throws for unknown agent", () => {
    it("throws", () => {
      expect(() => generate("unknown-agent" as any)).toThrow("unsupported agent");
    });
  });

  // -- Agent-specific tests --

  describe("pi", () => {
    it("produces lazy .pi/mcp.json and an agent skill", () => {
      const out = generate("pi", DEFAULT_OPTS);
      const mcpFile = out.files.find((f) => f.path === ".pi/mcp.json");
      const skill = out.files.find((f) => f.path === ".pi/skills/kcp-harness/SKILL.md");
      expect(mcpFile).toBeDefined();
      expect(skill).toBeDefined();
      const parsed = JSON.parse(mcpFile!.content);
      expect(parsed.settings.directTools).toBe(false);
      expect(parsed.mcpServers["kcp-harness"].lifecycle).toBe("lazy");
      expect(skill!.content).toContain("kcp_plan");
      expect(skill!.content).toContain("kcp_load");
    });

    it("states the MCP client prerequisite — stock Pi has no MCP", () => {
      const out = generate("pi", DEFAULT_OPTS);
      const skill = out.files.find((f) => f.path === ".pi/skills/kcp-harness/SKILL.md");
      expect(skill!.content).toContain("pi-mcp-adapter");
      expect(out.instructions).toContain("pi install npm:pi-mcp-adapter");
    });
  });

  describe("claude-code", () => {
    it("produces .mcp.json with mcpServers key", () => {
      const out = generate("claude-code", DEFAULT_OPTS);
      const mcpFile = out.files.find((f) => f.path === ".mcp.json");
      expect(mcpFile).toBeDefined();
      const parsed = JSON.parse(mcpFile!.content);
      expect(parsed.mcpServers["kcp-harness"]).toBeDefined();
      expect(parsed.mcpServers["kcp-harness"].command).toBe("npx");
    });

    it("produces CLAUDE.md with governed paths", () => {
      const out = generate("claude-code", DEFAULT_OPTS);
      const claudeMd = out.files.find((f) => f.path === "CLAUDE.md");
      expect(claudeMd).toBeDefined();
      expect(claudeMd!.content).toContain("docs/");
      expect(claudeMd!.content).toContain("fragments/");
    });

    it("produces hooks config", () => {
      const out = generate("claude-code", DEFAULT_OPTS);
      const settings = out.files.find((f) => f.path.includes("settings"));
      expect(settings).toBeDefined();
      const parsed = JSON.parse(settings!.content);
      expect(parsed.hooks?.PreToolUse).toBeDefined();
    });

    // The hook is the enforcement point for Claude Code's native file tools —
    // they never reach the proxy, so a hook that cannot fire means no
    // governance at all. Run the generated script the way Claude Code does:
    // hook payload as JSON on stdin, decision read back off stdout.
    describe("generated PreToolUse hook", () => {
      const runHook = (payload: unknown) => {
        const out = generate("claude-code", DEFAULT_OPTS);
        const settings = out.files.find((f) => f.path.includes("settings"))!;
        const hook = JSON.parse(settings.content).hooks.PreToolUse[0].hooks[0];
        const stdout = execFileSync(hook.command, hook.args, {
          input: JSON.stringify(payload),
          encoding: "utf-8",
        });
        return stdout.trim() ? JSON.parse(stdout) : null;
      };

      const denial = (result: any) => result?.hookSpecificOutput?.permissionDecision;

      it("denies a read of a governed path", () => {
        const result = runHook({
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: "docs/api.md" },
        });
        expect(denial(result)).toBe("deny");
        expect(result.hookSpecificOutput.permissionDecisionReason).toContain("kcp_load");
      });

      it("allows a read of an ungoverned path", () => {
        const result = runHook({
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: "package.json" },
        });
        expect(result).toBeNull();
      });

      it("denies a governed path nested under a parent directory", () => {
        const result = runHook({
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: "/repo/fragments/notes.md" },
        });
        expect(denial(result)).toBe("deny");
      });

      it("reads the target from tool_input, not the environment", () => {
        // Regression: the hook used to read process.env.TOOL_INPUT, which
        // Claude Code never sets — so every governed read was allowed through.
        const out = generate("claude-code", DEFAULT_OPTS);
        const settings = out.files.find((f) => f.path.includes("settings"))!;
        expect(settings.content).not.toContain("TOOL_INPUT");
      });

      it("fails closed when the payload cannot be parsed", () => {
        const out = generate("claude-code", DEFAULT_OPTS);
        const settings = out.files.find((f) => f.path.includes("settings"))!;
        const hook = JSON.parse(settings.content).hooks.PreToolUse[0].hooks[0];
        const stdout = execFileSync(hook.command, hook.args, {
          input: "not json",
          encoding: "utf-8",
        });
        expect(denial(JSON.parse(stdout))).toBe("deny");
      });

      // Red-team (issue #25): the hook is a best-effort string check, so it
      // must cover the ways an agent can reach a governed path other than a
      // plain Read — Bash, Glob/Grep patterns, case variants, backslashes —
      // mirroring src/classifier.ts. Each of these used to slip through.
      it("includes Bash in the matcher", () => {
        const out = generate("claude-code", DEFAULT_OPTS);
        const settings = out.files.find((f) => f.path.includes("settings"))!;
        expect(JSON.parse(settings.content).hooks.PreToolUse[0].matcher).toContain("Bash");
      });

      it("denies a Bash command that reads a governed path", () => {
        const result = runHook({
          tool_name: "Bash",
          tool_input: { command: "cat docs/api.md" },
        });
        expect(denial(result)).toBe("deny");
      });

      it("denies a Bash redirect that writes into a governed path", () => {
        const result = runHook({
          tool_name: "Bash",
          tool_input: { command: "echo hi > docs/out.md" },
        });
        expect(denial(result)).toBe("deny");
      });

      it("denies a Glob pattern that targets a governed directory", () => {
        const result = runHook({
          tool_name: "Glob",
          tool_input: { pattern: "docs/**/*.md" },
        });
        expect(denial(result)).toBe("deny");
      });

      it("denies a Grep scoped to a governed path", () => {
        const result = runHook({
          tool_name: "Grep",
          tool_input: { pattern: "SECRET", path: "docs" },
        });
        expect(denial(result)).toBe("deny");
      });

      it("denies a case-variant of a governed path", () => {
        const result = runHook({
          tool_name: "Read",
          tool_input: { file_path: "Docs/api.md" },
        });
        expect(denial(result)).toBe("deny");
      });

      it("denies a backslash-separated governed path", () => {
        const result = runHook({
          tool_name: "Read",
          tool_input: { file_path: "docs\\api.md" },
        });
        expect(denial(result)).toBe("deny");
      });

      it("does not over-block ungoverned Bash commands", () => {
        expect(runHook({ tool_name: "Bash", tool_input: { command: "npm test" } })).toBeNull();
        expect(runHook({ tool_name: "Bash", tool_input: { command: "git log docs/" } })).toBeNull();
      });
    });
  });

  describe("cursor", () => {
    it("produces .cursor/mcp.json with mcpServers", () => {
      const out = generate("cursor", DEFAULT_OPTS);
      const mcpFile = out.files.find((f) => f.path === ".cursor/mcp.json");
      expect(mcpFile).toBeDefined();
      const parsed = JSON.parse(mcpFile!.content);
      expect(parsed.mcpServers["kcp-harness"]).toBeDefined();
    });

    it("produces .mdc rules file", () => {
      const out = generate("cursor", DEFAULT_OPTS);
      const rules = out.files.find((f) => f.path.endsWith(".mdc"));
      expect(rules).toBeDefined();
      expect(rules!.content).toContain("docs/");
    });
  });

  describe("copilot", () => {
    it("uses 'servers' key (not mcpServers)", () => {
      const out = generate("copilot", DEFAULT_OPTS);
      const mcpFile = out.files.find((f) => f.path === ".vscode/mcp.json");
      expect(mcpFile).toBeDefined();
      const parsed = JSON.parse(mcpFile!.content);
      expect(parsed.servers).toBeDefined();
      expect(parsed.mcpServers).toBeUndefined();
    });

    it("produces copilot-instructions.md", () => {
      const out = generate("copilot", DEFAULT_OPTS);
      const instructions = out.files.find((f) => f.path.includes("copilot-instructions"));
      expect(instructions).toBeDefined();
    });
  });

  describe("windsurf", () => {
    it("produces snippet (not committed) + .windsurfrules (committed)", () => {
      const out = generate("windsurf", DEFAULT_OPTS);
      const snippet = out.files.find((f) => f.path.includes("snippet"));
      const rules = out.files.find((f) => f.path === ".windsurfrules");
      expect(snippet).toBeDefined();
      expect(snippet!.commitToGit).toBe(false);
      expect(rules).toBeDefined();
      expect(rules!.commitToGit).toBe(true);
    });
  });

  describe("cline", () => {
    it("includes autoApprove for read-only tools", () => {
      const out = generate("cline", DEFAULT_OPTS);
      const snippet = out.files.find((f) => f.path.includes("snippet"));
      expect(snippet).toBeDefined();
      const parsed = JSON.parse(snippet!.content);
      const harness = parsed["kcp-harness"];
      expect(harness.autoApprove).toContain("kcp_plan");
      expect(harness.autoApprove).toContain("harness_status");
      // kcp_load should NOT be auto-approved (write operation)
      expect(harness.autoApprove).not.toContain("kcp_load");
    });

    it("produces .clinerules", () => {
      const out = generate("cline", DEFAULT_OPTS);
      const rules = out.files.find((f) => f.path === ".clinerules");
      expect(rules).toBeDefined();
    });
  });

  describe("continue", () => {
    it("produces YAML config", () => {
      const out = generate("continue", DEFAULT_OPTS);
      const yaml = out.files.find((f) => f.path.endsWith(".yaml"));
      expect(yaml).toBeDefined();
      expect(yaml!.content).toContain("mcpServers:");
      expect(yaml!.content).toContain("kcp-harness");
    });
  });

  describe("crush", () => {
    it("includes prepareSteps for knowledge pre-loading", () => {
      const out = generate("crush", DEFAULT_OPTS);
      const config = out.files.find((f) => f.path === "crush.json");
      expect(config).toBeDefined();
      const parsed = JSON.parse(config!.content);
      expect(parsed.prepareSteps).toBeDefined();
      expect(parsed.prepareSteps[0].tool).toBe("kcp_plan");
    });
  });

  describe("openclaw", () => {
    it("includes plugin hooks", () => {
      const out = generate("openclaw", DEFAULT_OPTS);
      const config = out.files.find((f) => f.path === "openclaw.json");
      expect(config).toBeDefined();
      const parsed = JSON.parse(config!.content);
      expect(parsed.plugins["kcp-governance"]).toBeDefined();
      expect(parsed.plugins["kcp-governance"].hooks.before_prompt_build).toBeDefined();
      expect(parsed.plugins["kcp-governance"].hooks.before_agent_finalize).toBeDefined();
    });

    it("uses mcpServers key", () => {
      const out = generate("openclaw", DEFAULT_OPTS);
      const config = out.files.find((f) => f.path === "openclaw.json");
      const parsed = JSON.parse(config!.content);
      expect(parsed.mcpServers["kcp-harness"]).toBeDefined();
    });
  });

  describe("custom options", () => {
    it("respects custom harnessCommand and harnessArgs", () => {
      const out = generate("claude-code", {
        harnessCommand: "node",
        harnessArgs: ["./harness.js", "serve"],
        manifest: "./custom.yaml",
        paths: ["knowledge/"],
      });
      const mcpFile = out.files.find((f) => f.path === ".mcp.json");
      const parsed = JSON.parse(mcpFile!.content);
      expect(parsed.mcpServers["kcp-harness"].command).toBe("node");
      expect(parsed.mcpServers["kcp-harness"].args).toEqual(["./harness.js", "serve"]);
    });

    it("uses custom manifest in rules", () => {
      const out = generate("cline", {
        manifest: "./custom-knowledge.yaml",
        paths: ["data/"],
      });
      const rules = out.files.find((f) => f.path === ".clinerules");
      expect(rules!.content).toContain("custom-knowledge.yaml");
      expect(rules!.content).toContain("data/");
    });
  });
});

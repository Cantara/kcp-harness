#!/usr/bin/env node

// kcp-harness CLI — launch the compliance proxy.
//
// Usage:
//   kcp-harness serve [--config harness.yaml]   — start the MCP proxy
//   kcp-harness init                             — create a harness.yaml template
//   kcp-harness check [--config harness.yaml]    — validate the config
//
// The harness reads its configuration from harness.yaml (or the path given
// by --config). The config declares governed domains, policies, downstream
// MCP servers, and audit log settings.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, parseConfig, type HarnessConfig } from "./config.js";
import { serveProxy } from "./proxy.js";
import { generate, generateAll, listAgents } from "./integrations/generate.js";
import type { IntegrationOptions } from "./integrations/types.js";
import { exportEvidence } from "./export.js";
import { DashboardServer } from "./dashboard/server.js";
import { runApprovals } from "./approvals-cli.js";
import { AuditLog } from "./audit.js";

const USAGE = `kcp-harness — KCP Compliance Harness

Usage:
  kcp-harness serve  [--config harness.yaml]   Start the MCP proxy
  kcp-harness init                             Create a harness.yaml template
  kcp-harness check  [--config harness.yaml]   Validate configuration
  kcp-harness integrate <agent> [options]       Generate agent integration files
  kcp-harness integrate --list                  List supported agents
  kcp-harness export   [options]               Export compliance evidence
  kcp-harness dashboard [options]              Launch compliance dashboard
  kcp-harness approvals list [--state s]        List human-approval tickets
  kcp-harness approvals approve <id> --reviewer <name> --policy-ref <ref> [--note n]
  kcp-harness approvals dismiss <id> --reviewer <name> --policy-ref <ref> [--note n]
  kcp-harness --version                        Show version
  kcp-harness --help                           Show this help

Agents: pi, claude-code, cursor, windsurf, cline, continue, copilot, copilot-cli, crush, openclaw

The harness is an MCP proxy that enforces deterministic knowledge
governance for any agent. It intercepts tool calls, classifies them
as knowledge-navigation or pass-through, and routes governed calls
through the kcp-agent planner before execution.
`;

const VERSION = "0.6.0";

const TEMPLATE = `# kcp-harness configuration
version: "1.0"

governance:
  domains:
    - manifest: "./knowledge.yaml"
      paths:
        - "docs/"
        - "src/"
      # urls:
      #   - "https://docs.example.com/"
      # tools:
      #   - "custom_knowledge_tool"

  policy:
    fail_closed: true
    audit_all: true
    max_units: 5
    strict: false
    # budget:
    #   amount: 1.00
    #   currency: USDC
    # context_budget: 50000
    # env: prod
    # signature_required: true
    # trusted_keys:
    #   - "./keys/manifest-key.pem"

  # Confidence gate — harness_assess adjudicates an answer's confidence
  # against this threshold before it may be acted on; failures route to
  # the named approval role when set
  # confidence:
  #   threshold: 0.7
  #   severity: critical
  #   route_to_role: account-owner
  #   expires_after: 72h
  #   policy_ref: POL-9.1

  # Human-approval gates — calls matching a rule are held for a named
  # reviewer (resolve with: kcp-harness approvals approve <id> ...)
  # approvals:
  #   provider: file
  #   dir: .kcp-harness/approvals
  #   rules:
  #     - match: { tools: [Write, Edit], paths: [records/] }
  #       required_role: account-owner
  #       expires_after: 72h
  #       policy_ref: POL-7.2

downstream:
  # - name: "filesystem"
  #   command: "npx"
  #   args: ["-y", "@modelcontextprotocol/server-filesystem", "."]

audit:
  path: ".kcp-harness/audit.jsonl"
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  if (command === "--version" || command === "-v") {
    process.stdout.write(`kcp-harness ${VERSION}\n`);
    return;
  }

  const configPath = getFlag(args, "--config") ?? "harness.yaml";

  switch (command) {
    case "serve": {
      if (!existsSync(configPath)) {
        process.stderr.write(`[kcp-harness] config not found: ${configPath}\n`);
        process.stderr.write(`[kcp-harness] run 'kcp-harness init' to create one\n`);
        process.exit(1);
      }
      const config = loadConfig(configPath);
      process.stderr.write(`[kcp-harness] starting proxy (${config.governance.domains.length} governed domains)\n`);
      await serveProxy(config);
      break;
    }

    case "init": {
      const target = configPath === "harness.yaml" ? "harness.yaml" : configPath;
      if (existsSync(target)) {
        process.stderr.write(`[kcp-harness] ${target} already exists — not overwriting\n`);
        process.exit(1);
      }
      writeFileSync(target, TEMPLATE, "utf-8");
      process.stderr.write(`[kcp-harness] created ${target}\n`);
      break;
    }

    case "check": {
      if (!existsSync(configPath)) {
        process.stderr.write(`[kcp-harness] config not found: ${configPath}\n`);
        process.exit(1);
      }
      try {
        const config = loadConfig(configPath);
        process.stdout.write(JSON.stringify(config, null, 2) + "\n");
        process.stderr.write(`[kcp-harness] config valid: ${config.governance.domains.length} domain(s), ${config.downstream.length} downstream(s)\n`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[kcp-harness] config error: ${msg}\n`);
        process.exit(1);
      }
      break;
    }

    case "integrate": {
      const agent = args[1];

      if (!agent || agent === "--list") {
        const agents = listAgents();
        process.stdout.write("Supported agents:\n");
        for (const a of agents) {
          process.stdout.write(`  ${a}\n`);
        }
        break;
      }

      const opts: IntegrationOptions = {
        manifest: getFlag(args, "--manifest"),
        harnessConfig: getFlag(args, "--config"),
        harnessCommand: getFlag(args, "--command"),
        paths: getFlag(args, "--paths")?.split(","),
      };

      try {
        const output = generate(agent as any, opts);
        const outDir = getFlag(args, "--out") ?? ".";
        const dryRun = args.includes("--dry-run");

        process.stderr.write(`[kcp-harness] generating ${output.name} integration (${output.files.length} files)\n`);

        for (const file of output.files) {
          const filePath = join(outDir, file.path);
          if (dryRun) {
            process.stdout.write(`--- ${filePath} ---\n`);
            process.stdout.write(file.content);
            process.stdout.write("\n");
          } else {
            const dir = dirname(filePath);
            mkdirSync(dir, { recursive: true });
            writeFileSync(filePath, file.content, "utf-8");
            process.stderr.write(`[kcp-harness]   wrote ${filePath}\n`);
          }
        }

        process.stdout.write("\n" + output.instructions + "\n");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[kcp-harness] error: ${msg}\n`);
        process.exit(1);
      }
      break;
    }

    case "export": {
      const config = existsSync(configPath) ? loadConfig(configPath) : null;
      const auditPath = getFlag(args, "--audit") ?? config?.audit.path ?? ".kcp-harness/audit.jsonl";
      const outDir = getFlag(args, "--out") ?? "evidence";
      const format = (getFlag(args, "--format") ?? "both") as
        | "soc2"
        | "iso27001"
        | "iso42001"
        | "euaiact"
        | "both";
      const org = getFlag(args, "--org");
      const from = getFlag(args, "--from");
      const to = getFlag(args, "--to");

      if (!existsSync(auditPath)) {
        process.stderr.write(`[kcp-harness] audit log not found: ${auditPath}\n`);
        process.exit(1);
      }

      try {
        const result = await exportEvidence({
          auditPath,
          outputDir: outDir,
          format,
          organization: org,
          dateRange: from || to ? { from: from ?? "", to: to ?? "" } : undefined,
        });
        process.stderr.write(`[kcp-harness] exported ${result.files.length} files to ${result.outputDir}\n`);
        process.stderr.write(`[kcp-harness]   ${result.summary.events} events, ${result.summary.sessions} sessions\n`);
        for (const f of result.files) {
          process.stdout.write(`  ${f}\n`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[kcp-harness] export error: ${msg}\n`);
        process.exit(1);
      }
      break;
    }

    case "dashboard": {
      const config = existsSync(configPath) ? loadConfig(configPath) : null;
      const auditPath = getFlag(args, "--audit") ?? config?.audit.path ?? ".kcp-harness/audit.jsonl";
      const port = Number(getFlag(args, "--port") ?? "3847");
      const host = getFlag(args, "--host") ?? "127.0.0.1";

      if (!existsSync(auditPath)) {
        process.stderr.write(`[kcp-harness] audit log not found: ${auditPath}\n`);
        process.stderr.write(`[kcp-harness] the dashboard reads from the audit log — run the proxy first\n`);
        process.exit(1);
      }

      const dashboard = new DashboardServer({ auditPath, port, host });
      await dashboard.start();
      process.stderr.write(`[kcp-harness] dashboard running at ${dashboard.getAddress()}\n`);
      process.stderr.write(`[kcp-harness] watching ${auditPath} for live updates\n`);

      // Keep running until SIGINT/SIGTERM
      const shutdown = async () => {
        process.stderr.write(`\n[kcp-harness] shutting down dashboard\n`);
        await dashboard.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      break;
    }

    case "approvals": {
      if (!existsSync(configPath)) {
        process.stderr.write(`[kcp-harness] config not found: ${configPath}\n`);
        process.exit(1);
      }
      try {
        const config = loadConfig(configPath);
        const audit = new AuditLog(config.audit.path);
        const out = await runApprovals(args.slice(1), config, audit);
        process.stdout.write(out);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[kcp-harness] approvals error: ${msg}\n`);
        process.exit(1);
      }
      break;
    }

    default:
      process.stderr.write(`[kcp-harness] unknown command: ${command}\n\n`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

main().catch((e) => {
  process.stderr.write(`[kcp-harness] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

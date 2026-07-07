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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadConfig, parseConfig, type HarnessConfig } from "./config.js";
import { serveProxy } from "./proxy.js";

const USAGE = `kcp-harness — KCP Compliance Harness

Usage:
  kcp-harness serve  [--config harness.yaml]   Start the MCP proxy
  kcp-harness init                             Create a harness.yaml template
  kcp-harness check  [--config harness.yaml]   Validate configuration
  kcp-harness --version                        Show version
  kcp-harness --help                           Show this help

The harness is an MCP proxy that enforces deterministic knowledge
governance for any agent. It intercepts tool calls, classifies them
as knowledge-navigation or pass-through, and routes governed calls
through the kcp-agent planner before execution.
`;

const VERSION = "0.1.0";

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

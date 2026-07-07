// MCP proxy server — the harness's main entry point.
//
// The proxy sits between an agent (upstream) and downstream MCP servers.
// It presents itself as a single MCP server to the agent, aggregating
// tools from all downstream servers plus the harness's own governance tools.
//
// Every tool call flows through the pipeline:
//   classify → govern → execute → audit
//
// Governed calls are routed through the kcp-agent planner before the
// downstream server is contacted. The agent can't bypass governance
// because it only has access to the proxy's stdio — not the downstream
// servers' stdio directly.

import { createInterface } from "node:readline";
import type { HarnessConfig } from "./config.js";
import { classify } from "./classifier.js";
import { govern, type GovernanceDecision } from "./governor.js";
import {
  AuditLog,
  InMemoryAuditLog,
  buildEvent,
  type AuditWriter,
  type AuditEvent,
} from "./audit.js";
import { createSession, nextSequence, type SessionState } from "./session.js";
import { DownstreamManager, type McpTool } from "./downstream.js";
import { callKcpTool } from "./kcp-bridge.js";

const HARNESS_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: JsonRpcRequest["id"], result: unknown) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  result,
});
const rpcError = (id: JsonRpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

// -- Harness-specific tools --------------------------------------------------

const HARNESS_TOOLS: McpTool[] = [
  {
    name: "harness_status",
    description:
      "Show the harness's current governance state: session ID, approved plans, " +
      "known units, budget spent, and audit log path.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "harness_session",
    description:
      "Show the current session's approved plans and their selected units. " +
      "Use this to see what knowledge the governance layer has approved.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** KCP tool names that the harness routes to kcp-agent directly. */
const KCP_TOOLS = new Set(["kcp_plan", "kcp_load", "kcp_trace", "kcp_validate", "kcp_replay"]);

// -- Proxy server -----------------------------------------------------------

export interface ProxyOptions {
  config: HarnessConfig;
  audit?: AuditWriter;
}

export class HarnessProxy {
  private readonly config: HarnessConfig;
  private readonly downstream: DownstreamManager;
  private readonly audit: AuditWriter;
  private readonly session: SessionState;

  constructor(options: ProxyOptions) {
    this.config = options.config;
    this.downstream = new DownstreamManager();
    this.audit = options.audit ?? new AuditLog(options.config.audit.path);
    this.session = createSession();
  }

  /** Start the proxy: spawn downstream servers and begin serving. */
  async start(): Promise<void> {
    // Spawn and initialize downstream servers
    for (const ds of this.config.downstream) {
      try {
        await this.downstream.add(ds);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[kcp-harness] failed to spawn downstream ${ds.name}: ${msg}\n`);
      }
    }
  }

  /** Shut down the proxy and all downstream connections. */
  async stop(): Promise<void> {
    await this.downstream.shutdown();
  }

  /** Handle one JSON-RPC message from the agent. */
  async handleMessage(msg: JsonRpcRequest): Promise<object | null> {
    switch (msg.method) {
      case "initialize":
        return rpcResult(msg.id, {
          protocolVersion:
            typeof msg.params?.["protocolVersion"] === "string"
              ? msg.params["protocolVersion"]
              : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "kcp-harness", version: HARNESS_VERSION },
        });

      case "ping":
        return rpcResult(msg.id, {});

      case "tools/list":
        return rpcResult(msg.id, { tools: this.listTools() });

      case "tools/call": {
        const name = String(msg.params?.["name"] ?? "");
        const args = (msg.params?.["arguments"] ?? {}) as Record<string, unknown>;
        return this.handleToolCall(msg.id, name, args);
      }

      default:
        // Notifications (no id) are acknowledged silently
        if (msg.id === undefined || msg.method?.startsWith("notifications/")) return null;
        return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
    }
  }

  /** List all available tools (downstream + harness + KCP). */
  private listTools(): McpTool[] {
    const downstreamTools = this.downstream.allTools();
    // Import KCP tools from kcp-agent
    const kcpTools = [
      {
        name: "kcp_plan",
        description:
          "Produce a deterministic, inspectable load plan for a task against a KCP knowledge.yaml. " +
          "Routes through the governance harness for compliance tracking.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "The task to plan knowledge loading for" },
            manifest: { type: "string", description: "Path, directory, or HTTPS URL of a knowledge.yaml" },
          },
          required: ["task", "manifest"],
        },
      },
      {
        name: "kcp_load",
        description:
          "Plan and load knowledge content through the governance harness. " +
          "Automatically tracks session dedup and budget.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "The task to plan knowledge loading for" },
            manifest: { type: "string", description: "Path, directory, or HTTPS URL of a knowledge.yaml" },
          },
          required: ["task", "manifest"],
        },
      },
      {
        name: "kcp_trace",
        description:
          "Produce a decision trace: every unit annotated with gate cascade verdicts.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "The task to trace" },
            manifest: { type: "string", description: "Path, directory, or HTTPS URL of a knowledge.yaml" },
          },
          required: ["task", "manifest"],
        },
      },
      {
        name: "kcp_validate",
        description: "Validate (lint) a knowledge.yaml.",
        inputSchema: {
          type: "object",
          properties: {
            manifest: { type: "string", description: "Path, directory, or HTTPS URL of a knowledge.yaml" },
          },
          required: ["manifest"],
        },
      },
      {
        name: "kcp_replay",
        description: "Cross-examine a saved plan artifact against live manifests.",
        inputSchema: {
          type: "object",
          properties: {
            artifact: { description: "The plan artifact JSON" },
          },
          required: ["artifact"],
        },
      },
    ];

    return [...HARNESS_TOOLS, ...kcpTools, ...downstreamTools];
  }

  /** Handle a tool call through the governance pipeline. */
  private async handleToolCall(
    id: JsonRpcRequest["id"],
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<object> {
    const startTime = Date.now();
    const seq = nextSequence(this.session);

    try {
      // Step 1: Classify
      const classification = classify(
        toolName,
        args,
        this.config.governance.domains,
      );

      // Step 2: Govern (for governed calls)
      let governance: GovernanceDecision | undefined;
      if (classification.governed) {
        governance = await govern(
          classification,
          toolName,
          args,
          this.session,
          this.config.governance.policy,
        );

        if (!governance.approved) {
          // Blocked — emit audit and return error
          const event = buildEvent(
            this.session.id,
            seq,
            toolName,
            args,
            classification,
            governance,
            "blocked",
            Date.now() - startTime,
          );
          this.audit.emit(event);

          return rpcResult(id, {
            content: [
              {
                type: "text",
                text: `[kcp-harness] BLOCKED: ${governance.reason}`,
              },
            ],
            isError: true,
          });
        }
      }

      // Step 3: Execute
      let result: unknown;

      if (HARNESS_TOOLS.some((t) => t.name === toolName)) {
        // Harness-internal tool
        result = await this.handleHarnessTool(toolName, args);
      } else if (KCP_TOOLS.has(toolName)) {
        // KCP tool — delegate to kcp-agent via the bridge
        const text = await callKcpTool(toolName, args);
        result = { content: [{ type: "text", text }], isError: false };
      } else {
        // Downstream tool — forward to the owning downstream server
        result = await this.downstream.callTool(toolName, args);
      }

      // Step 4: Audit
      const outcome = classification.governed ? "approved" : "pass-through";
      if (this.config.governance.policy.audit_all || classification.governed) {
        const event = buildEvent(
          this.session.id,
          seq,
          toolName,
          args,
          classification,
          governance,
          outcome,
          Date.now() - startTime,
        );
        this.audit.emit(event);
      }

      return rpcResult(id, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      // Audit the error
      const classification = classify(toolName, args, this.config.governance.domains);
      const event = buildEvent(
        this.session.id,
        seq,
        toolName,
        args,
        classification,
        undefined,
        "error",
        Date.now() - startTime,
        msg,
      );
      this.audit.emit(event);

      return rpcResult(id, {
        content: [{ type: "text", text: `[kcp-harness] error: ${msg}` }],
        isError: true,
      });
    }
  }

  /** Handle harness-internal tools. */
  private async handleHarnessTool(
    name: string,
    _args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
    switch (name) {
      case "harness_status": {
        const status = {
          session: {
            id: this.session.id,
            startedAt: this.session.startedAt,
            sequence: this.session.sequence,
            plansCount: this.session.plans.size,
            knownUnitsCount: this.session.known.size,
            budgetSpent: this.session.budgetSpent,
          },
          governance: {
            domains: this.config.governance.domains.length,
            policy: this.config.governance.policy,
          },
          downstream: this.config.downstream.map((d) => d.name),
          audit: { path: this.audit.getPath() },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
          isError: false,
        };
      }

      case "harness_session": {
        const plans: Record<string, unknown> = {};
        for (const [manifest, approved] of this.session.plans) {
          plans[manifest] = {
            task: approved.task,
            approvedAt: approved.approvedAt,
            selected: approved.plan.selected.map((u) => ({
              id: u.id,
              path: u.path,
              score: u.score,
              loadEligible: u.loadEligible,
            })),
            skipped: approved.plan.skipped.length,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ sessionId: this.session.id, plans }, null, 2) }],
          isError: false,
        };
      }

      default:
        return {
          content: [{ type: "text", text: `unknown harness tool: ${name}` }],
          isError: true,
        };
    }
  }

  /** Expose session for testing. */
  getSession(): SessionState {
    return this.session;
  }
}

/** Serve the harness proxy over stdio until stdin closes. */
export async function serveProxy(config: HarnessConfig): Promise<void> {
  const proxy = new HarnessProxy({ config });
  await proxy.start();

  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(
        JSON.stringify(rpcError(null, -32700, "parse error")) + "\n",
      );
      continue;
    }

    const response = await proxy.handleMessage(msg);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  }

  await proxy.stop();
}

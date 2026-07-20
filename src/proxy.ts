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
import { govern, type GovernanceDecision, type ApprovalContext } from "./governor.js";
import { providerFromConfig, latestForCall, newRequest, parseDuration, type ApprovalProvider } from "./approval.js";
import { assess } from "kcp-agent";
import {
  AuditLog,
  InMemoryAuditLog,
  buildEvent,
  buildLifecycleEvent,
  buildBudgetEvent,
  buildDriftEvent,
  buildApprovalEvent,
  buildConfidenceEvent,
  type AuditWriter,
  type AuditEvent,
} from "./audit.js";
import { createSession, nextSequence, type SessionState } from "./session.js";
import { DownstreamManager, type McpTool } from "./downstream.js";
import { callKcpTool } from "./kcp-bridge.js";
import { toTraceEvent, emitTrace } from "./trace-emit.js";
import type { DecisionTrace } from "kcp-agent";
import type { BudgetCeiling } from "./budget-ledger.js";

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
  {
    name: "harness_budget",
    description:
      "Show the session budget ledger: ceiling, running totals, remaining budget, " +
      "and itemized spend history.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "harness_temporal_check",
    description:
      "Check all approved plans for temporal drift: re-evaluate against current " +
      "time and report any plans that would produce different results now.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "harness_approvals",
    description:
      "List human-approval tickets: calls held for a named reviewer. " +
      "A pending call is denied with its ticket id — re-try it after approval.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          description: "Filter by state: pending_review, approved, dismissed, expired",
        },
      },
    },
  },
  {
    name: "harness_assess",
    description:
      "Confidence-gate a synthesized answer before acting on it. Runs kcp-agent's " +
      "post-synthesis assess(): the answer's self-reported confidence is adjudicated " +
      "against the org threshold. A failed verdict is routed to a named human when " +
      "governance.confidence.route_to_role is set — re-try after approval.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task the answer concludes" },
        answer: { type: "string", description: "The synthesized answer to gate" },
        threshold: {
          type: "number",
          description: "Optional tightening of the configured threshold (the strictest wins)",
        },
        severity: { type: "string", description: "Severity label override (e.g. critical)" },
      },
      required: ["task", "answer"],
    },
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
  private readonly approvals?: ApprovalContext;

  constructor(options: ProxyOptions) {
    this.config = options.config;
    this.downstream = new DownstreamManager();
    this.audit = options.audit ?? new AuditLog(options.config.audit.path);

    const approvalsConfig = options.config.governance.approvals;
    if (approvalsConfig) {
      this.approvals = {
        provider: providerFromConfig(approvalsConfig),
        rules: approvalsConfig.rules,
      };
    }

    // Derive budget ceiling from policy
    const policy = options.config.governance.policy;
    const ceiling: BudgetCeiling | undefined = policy.budget
      ? { amount: policy.budget.amount, currency: policy.budget.currency ?? "USDC" }
      : undefined;
    this.session = createSession(ceiling);
  }

  /** Start the proxy: spawn downstream servers and begin serving. */
  async start(): Promise<void> {
    // Emit session start event
    const seq = nextSequence(this.session);
    this.audit.emit(buildLifecycleEvent(this.session.id, seq, "session_start", {
      domains: this.config.governance.domains.length,
      downstream: this.config.downstream.map((d) => d.name),
      budget: this.session.ledger.getCeiling(),
    }));

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
    // Emit session end event
    const seq = nextSequence(this.session);
    this.audit.emit(buildLifecycleEvent(this.session.id, seq, "session_end", {
      totalCalls: this.session.sequence,
      budgetSnapshot: this.session.ledger.snapshot(),
      plansCount: this.session.plans.size,
      knownUnitsCount: this.session.known.size,
    }));

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
          this.approvals,
        );

        // A freshly opened ticket is its own audit event
        if (governance.submitted && governance.pendingId && this.approvals) {
          const status = await this.approvals.provider.check(governance.pendingId);
          if (status) {
            this.audit.emit(
              buildApprovalEvent(this.session.id, nextSequence(this.session), "approval_requested", status),
            );
          }
        }

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
        // Opt-in, fail-open: ship the decision trace to the dashboard.
        this.maybeEmitTrace(toolName, args, text);
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

  /**
   * Ship a decision trace to the dashboard when one is available (kcp_trace)
   * and a dashboard URL is configured. Opt-in and fully fail-open — any error
   * here is swallowed so telemetry never affects the tool result.
   */
  private maybeEmitTrace(toolName: string, args: Record<string, unknown>, text: string): void {
    const url = this.config.dashboard?.url;
    if (!url || toolName !== "kcp_trace") return;
    try {
      const trace = JSON.parse(text) as DecisionTrace;
      emitTrace(url, toTraceEvent(trace, {
        sessionId: this.session.id,
        project: process.cwd(),
        manifest: typeof args["manifest"] === "string" ? (args["manifest"] as string) : undefined,
      }));
    } catch {
      /* fail-open: never let telemetry break governance */
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

      case "harness_budget": {
        const snapshot = this.session.ledger.snapshot();
        const entries = this.session.ledger.getEntries();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...snapshot,
              entries: entries.map((e) => ({
                seq: e.seq,
                timestamp: e.timestamp,
                manifest: e.source.manifest,
                unitId: e.source.unitId,
                amount: e.cost.amount,
                currency: e.cost.currency,
                method: e.cost.method,
                runningTotal: e.runningTotal,
              })),
            }, null, 2),
          }],
          isError: false,
        };
      }

      case "harness_temporal_check": {
        const watchResult = await this.session.temporalWatch.check();

        // Emit drift audit events for any drifted plans
        for (const drift of watchResult.drifted) {
          const driftSeq = nextSequence(this.session);
          this.audit.emit(buildDriftEvent(this.session.id, driftSeq, drift));
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              checked: watchResult.checked,
              stable: watchResult.stable,
              drifted: watchResult.drifted.map((d) => ({
                manifest: d.manifest,
                task: d.task,
                summary: d.summary,
                moves: d.diff?.moves.length ?? 0,
                scoreChanges: d.diff?.scoreChanges.length ?? 0,
              })),
              errors: watchResult.errors,
            }, null, 2),
          }],
          isError: false,
        };
      }

      case "harness_approvals": {
        if (!this.approvals) {
          return {
            content: [{ type: "text", text: "no approval rules configured — see governance.approvals in harness.yaml" }],
            isError: false,
          };
        }
        const stateFilter = typeof _args["state"] === "string" ? (_args["state"] as string) : undefined;
        const statuses = await this.approvals.provider.list(
          stateFilter ? { state: stateFilter as never } : undefined,
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              approvals: statuses.map((s) => ({
                id: s.request.id,
                state: s.state,
                toolName: s.request.toolName,
                target: s.request.target,
                requiredRole: s.request.requiredRole,
                requestedAt: s.request.requestedAt,
                expiresAt: s.request.expiresAt,
                policyRef: s.resolution?.policyRef ?? s.request.evidence.policyRef,
                reviewer: s.resolution?.reviewer,
                reviewedAt: s.resolution?.reviewedAt,
                note: s.resolution?.note,
              })),
            }, null, 2),
          }],
          isError: false,
        };
      }

      case "harness_assess":
        return this.handleAssess(_args);

      default:
        return {
          content: [{ type: "text", text: `unknown harness tool: ${name}` }],
          isError: true,
        };
    }
  }

  /**
   * Confidence-gate an answer: kcp-agent's assess() decides, the harness
   * enforces. A failed verdict on a routed config opens an approval ticket
   * carrying the verdict as evidence; a named human's approval overrides
   * the gate on retry. Dismissal is terminal.
   */
  private async handleAssess(
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
    const err = (text: string) => ({ content: [{ type: "text", text }], isError: true });
    const ok = (body: unknown) => ({
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      isError: false,
    });

    const task = typeof args["task"] === "string" ? (args["task"] as string) : "";
    const answer = typeof args["answer"] === "string" ? (args["answer"] as string) : "";
    if (!task) return err("harness_assess requires a task");
    if (!answer) return err("harness_assess requires an answer to gate");

    const confidence = this.config.governance.confidence;
    const callerThreshold = typeof args["threshold"] === "number" ? (args["threshold"] as number) : undefined;
    // Strictest wins: a caller may tighten org policy, never loosen it.
    const candidates = [confidence?.threshold, callerThreshold].filter((t): t is number => t !== undefined);
    if (candidates.length === 0) {
      return err("harness_assess: no threshold — set governance.confidence.threshold or pass one");
    }
    const threshold = Math.max(...candidates);
    const severity =
      typeof args["severity"] === "string" ? (args["severity"] as string) : confidence?.severity;

    const verdict = await assess(task, answer, [], { threshold, severity });

    const routing = confidence?.route_to_role && this.approvals ? confidence : undefined;
    let ticketInfo: Record<string, unknown> | undefined;
    let override: Record<string, unknown> | undefined;
    let dismissed: Record<string, unknown> | undefined;
    let allowed = verdict.passed;

    if (!verdict.passed && routing && this.approvals) {
      const provider = this.approvals.provider;
      const existing = await latestForCall(provider, task, "harness_assess");

      if (existing?.state === "approved" && existing.resolution) {
        // The gate failed, but a named human has overridden it for this task.
        allowed = true;
        override = {
          reviewer: existing.resolution.reviewer,
          reviewedAt: existing.resolution.reviewedAt,
          policyRef: existing.resolution.policyRef,
          ticketId: existing.request.id,
        };
      } else if (existing?.state === "pending_review") {
        ticketInfo = ticketSummary(existing.request.id, existing.state, existing.request.requiredRole);
      } else if (existing?.state === "dismissed" && existing.resolution) {
        dismissed = {
          reviewer: existing.resolution.reviewer,
          note: existing.resolution.note,
          ticketId: existing.request.id,
        };
      } else {
        // None yet, or the last ticket expired → open a fresh one with the
        // verdict as evidence, generated at gate time.
        const request = newRequest({
          sessionId: this.session.id,
          toolName: "harness_assess",
          target: task,
          task,
          requiredRole: routing.route_to_role!,
          expiresAt: routing.expires_after
            ? new Date(Date.now() + parseDuration(routing.expires_after)).toISOString()
            : undefined,
          evidence: {
            policyRef: routing.policy_ref,
            detail: verdict.detail,
            confidence: verdict,
          },
        });
        await provider.submit(request);
        const status = await provider.check(request.id);
        if (status) {
          this.audit.emit(
            buildApprovalEvent(this.session.id, nextSequence(this.session), "approval_requested", status),
          );
        }
        ticketInfo = ticketSummary(request.id, "pending_review", routing.route_to_role!);
      }
    }

    this.audit.emit(
      buildConfidenceEvent(
        this.session.id,
        nextSequence(this.session),
        task,
        verdict,
        ticketInfo ? (ticketInfo["id"] as string) : undefined,
      ),
    );

    return ok({
      allowed,
      verdict,
      ...(ticketInfo ? { ticket: ticketInfo } : {}),
      ...(override ? { override } : {}),
      ...(dismissed ? { dismissed } : {}),
    });
  }

  /** Expose session for testing. */
  getSession(): SessionState {
    return this.session;
  }

  /** Expose the approval ticket store (for testing and embedding). */
  getApprovalProvider(): ApprovalProvider | undefined {
    return this.approvals?.provider;
  }
}

function ticketSummary(id: string, state: string, requiredRole: string): Record<string, unknown> {
  return { id, state, requiredRole };
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

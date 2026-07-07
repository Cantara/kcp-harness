// kcp-harness — public API.
//
// The KCP Compliance Harness: an MCP proxy that enforces deterministic
// knowledge governance for any agent. The harness intercepts tool calls,
// classifies them as knowledge-navigation or pass-through, and routes
// governed calls through the kcp-agent planner before execution.
//
// Every decision is logged to an append-only audit log. The agent can't
// bypass governance because it only has access to the proxy's stdio.

export {
  classify,
  extractTargets,
  normalizePath,
  matchesPrefix,
  type Classification,
} from "./classifier.js";

export {
  govern,
  type GovernanceDecision,
} from "./governor.js";

export {
  AuditLog,
  InMemoryAuditLog,
  buildEvent,
  type AuditWriter,
  type AuditEvent,
} from "./audit.js";

export {
  createSession,
  addPlan,
  isPathApproved,
  recordLoaded,
  getKnown,
  recordSpend,
  nextSequence,
  type SessionState,
  type ApprovedPlan,
} from "./session.js";

export {
  DownstreamManager,
  type McpTool,
  type DownstreamConnection,
} from "./downstream.js";

export {
  HarnessProxy,
  serveProxy,
  type ProxyOptions,
} from "./proxy.js";

export {
  loadConfig,
  parseConfig,
  DEFAULT_POLICY,
  DEFAULT_AUDIT,
  type HarnessConfig,
  type GovernedDomain,
  type GovernancePolicy,
  type DownstreamConfig,
  type AuditConfig,
} from "./config.js";

export { callKcpTool } from "./kcp-bridge.js";

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
  buildLifecycleEvent,
  buildBudgetEvent,
  buildDriftEvent,
  type AuditWriter,
  type AuditEvent,
  type AuditEventType,
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

export {
  BudgetLedger,
  type BudgetCeiling,
  type LedgerEntry,
  type LedgerSource,
  type LedgerCost,
  type LedgerSnapshot,
  type SpendResult,
} from "./budget-ledger.js";

export {
  TemporalWatch,
  type WatchedPlan,
  type DriftResult,
  type WatchResult,
} from "./temporal-watch.js";

export {
  generate,
  generateAll,
  listAgents,
  harnessServerEntry,
  governedPathsBlock,
  manifestRef,
} from "./integrations/generate.js";

export {
  AGENTS,
  type AgentTarget,
  type IntegrationOutput,
  type IntegrationFile,
  type IntegrationOptions,
  type AgentInfo,
} from "./integrations/types.js";

export {
  AuditReader,
  type AuditFilter,
  type AuditSummary,
  type SessionEntry,
  type SessionIndex,
} from "./audit-reader.js";

export {
  exportEvidence,
  type ExportOptions,
  type ExportResult,
} from "./export.js";

export {
  DashboardServer,
  type DashboardOptions,
} from "./dashboard/server.js";

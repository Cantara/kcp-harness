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
  type ApprovalContext,
} from "./governor.js";

export {
  InMemoryApprovalProvider,
  FileApprovalProvider,
  providerFromConfig,
  newRequest,
  parseDuration,
  latestForCall,
  resolutionPayload,
  type ApprovalProvider,
  type ApprovalRequest,
  type ApprovalResolution,
  type ApprovalStatus,
  type ApprovalState,
  type SignaturePolicy,
} from "./approval.js";

export {
  canonicalResolutionPayload,
  signResolution,
  signPayload,
  verifyResolutionSignature,
  signEvidence,
  verifyEvidence,
  importPublicKey,
  importPrivateKey,
  type ResolutionSignature,
  type ResolutionSignaturePayload,
  type EvidenceSignature,
} from "./resolution-signature.js";

export {
  canonicalPurchaseReceiptPayload,
  signPurchaseReceipt,
  verifyPurchaseReceipt,
  type PurchaseReceiptPayload,
  type PurchaseReceiptSignature,
} from "./purchase-receipt.js";

// The correlation helpers are public because the evidence chain crosses repositories: a
// runtime composing planner + proxy (pi-kcp) has to know what this proxy records for a tool
// call in order to join its own records to the audit trail. Without them a consumer can only
// hardcode an assumption about our internals, and the join breaks silently the day we change
// how a traceparent is reduced.
export { correlationKey, deriveCorrelation, parseTraceparent, traceparentFromArgs } from "./correlation.js";
export type { Correlation } from "./correlation.js";

export { runApprovals } from "./approvals-cli.js";

export {
  AuditLog,
  InMemoryAuditLog,
  buildEvent,
  buildLifecycleEvent,
  buildBudgetEvent,
  buildPurchaseEvent,
  buildDriftEvent,
  buildApprovalEvent,
  buildConfidenceEvent,
  buildConformanceEvent,
  buildSkillEvent,
  verifyAuditChain,
  hashAuditEntry,
  GENESIS_HASH,
  type AuditWriter,
  type AuditEvent,
  type AuditEventType,
  type ChainVerification,
} from "./audit.js";

export { canonicalJSON, sha256Hex } from "./canonical.js";

export {
  toTraceEvent,
  emitTrace,
  canonicalTraceEvent,
  signTraceEvent,
  verifyTraceEvent,
  type TraceEvent,
  type TraceEventUnit,
  type TraceContext,
} from "./trace-emit.js";

export {
  checkConformance,
  type ConformanceVerdict,
  type ObservedAction,
  type ActionScope,
} from "./conformance.js";

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
  DEFAULT_APPROVALS_DIR,
  type HarnessConfig,
  type GovernedDomain,
  type GovernancePolicy,
  type DownstreamConfig,
  type AuditConfig,
  type ApprovalRule,
  type ApprovalsConfig,
  type ConfidenceConfig,
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
  type BundleSeal,
} from "./export.js";

export {
  DashboardServer,
  type DashboardOptions,
} from "./dashboard/server.js";

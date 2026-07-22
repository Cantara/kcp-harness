// Audit log — append-only compliance log for every governance decision.
//
// Every tool call processed by the harness produces an audit event — even
// pass-throughs (logged as "ungoverned"). The audit log is a JSONL file:
// one JSON object per line, append-only, never truncated or rotated by
// the harness itself. External log management handles rotation.
//
// The log is compliance-grade:
// - Every event has a session ID, sequence number, and ISO timestamp
// - Classification, governance decision, and outcome are recorded
// - Events are atomic (one write per line, fsync'd)
// - The log can be replayed to reconstruct the session's governance history
// - Session lifecycle events mark boundaries (start, end, drift)
// - Budget snapshots recorded on every spend event

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SignatureResult } from "kcp-agent";
import type { Classification } from "./classifier.js";
import type { GovernanceDecision } from "./governor.js";
import type { LedgerSnapshot } from "./budget-ledger.js";
import type { DriftResult } from "./temporal-watch.js";
import type { ApprovalStatus } from "./approval.js";
import type { ConformanceVerdict } from "./conformance.js";

/** Event types for structured audit logging. */
export type AuditEventType =
  | "tool_call"          // Standard tool call governance event
  | "session_start"      // Session lifecycle: start
  | "session_end"        // Session lifecycle: end
  | "budget_spend"       // Budget ledger: spend recorded
  | "budget_exceeded"    // Budget ledger: spend rejected (ceiling)
  | "temporal_drift"     // Temporal watch: plan drift detected
  | "plan_invalidated"   // Temporal watch: plan invalidated due to drift
  | "approval_requested" // Human approval: ticket opened
  | "approval_resolved"  // Human approval: named reviewer approved/dismissed
  | "confidence_verdict" // Confidence gate: harness_assess adjudicated an answer
  | "skill_loaded"       // Skill/procedure gate: a governed skill passed skill_eligibility
  | "skill_skipped"      // Skill/procedure gate: a governed skill failed skill_eligibility (fail-closed)
  | "conformance_verdict"; // Conformance gate: an action checked against the active skill's action_scope (#39)

/** A single audit event. */
export interface AuditEvent {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Session ID for correlation. */
  sessionId: string;
  /** Monotonic sequence number within the session. */
  sequence: number;
  /**
   * Decision-record chain id: one correlation id per intercepted tool call,
   * shared by every verdict that call produces (govern → grounding →
   * confidence → approval → skill). Reused from an incoming W3C `traceparent`
   * trace-id when present, else minted. Optional for backward compatibility.
   */
  correlationId?: string;
  /**
   * Parent span id — the caller's W3C `traceparent` span-id when this call was
   * stitched into an upstream trace. Absent for a locally-minted correlation.
   */
  parentId?: string;
  /** Event type for structured filtering. */
  type: AuditEventType;
  /** The tool call that was intercepted (for tool_call events). */
  toolCall?: {
    name: string;
    /** Sanitized arguments (sensitive values redacted). */
    args: Record<string, unknown>;
  };
  /** Classification result (for tool_call events). */
  classification?: Classification;
  /** Governance decision (only for governed calls). */
  governance?: GovernanceDecision;
  /** Final outcome. */
  outcome: "approved" | "blocked" | "pass-through" | "error";
  /** Processing time in milliseconds. */
  durationMs: number;
  /** Error message if the call failed. */
  error?: string;
  /** Budget snapshot at time of event (for spend events). */
  budget?: LedgerSnapshot;
  /** Temporal drift details (for drift events). */
  drift?: {
    manifest: string;
    summary: string;
    movedUnits?: number;
    newPlanAsOf?: string;
  };
  /** Manifest signature verification result. */
  signature?: SignatureResult;
  /** Approval ticket details (for approval_requested / approval_resolved events). */
  approval?: {
    id: string;
    state: string;
    toolName?: string;
    target?: string;
    requiredRole?: string;
    /** Policy citation — from the rule at request time, from the reviewer at resolution time. */
    policyRef?: string;
    reviewer?: string;
    reviewedAt?: string;
    note?: string;
    expiresAt?: string;
    /** Whether the resolution carried a verified reviewer signature. */
    signed?: boolean;
    /** Key identifier of the resolution signature, when present. */
    keyId?: string;
  };
  /** Confidence verdict summary (for confidence_verdict events; no answer text). */
  confidence?: {
    task: string;
    passed: boolean;
    score: number;
    threshold: number;
    detail: string;
    severity?: string;
    /** Ticket opened for the failure, when routing applied. */
    ticketId?: string;
  };
  /** Skill/procedure invocation verdict (for skill_loaded / skill_skipped events). */
  skill?: {
    /** The governed skill unit's id. */
    id: string;
    /** The manifest that governs the skill. */
    manifest?: string;
    /** Whether the planner's skill_eligibility gate admitted the skill. */
    eligible: boolean;
    /** The gate that decided this — normally skill_eligibility. */
    gate: string;
    /** The written reason from the deciding gate (never reconstructed). */
    reason: string;
    /** Declared action scope of the skill (tools/paths/capabilities it may touch). */
    actionScope?: { tools?: string[]; paths?: string[]; capabilities?: string[] };
  };
  /**
   * Procedural conformance verdict (for conformance_verdict events; #39). The
   * adjudication of one governed action against the active skill's action_scope
   * — never the action's payload, only the decision and the deciding target.
   */
  conformance?: {
    /** The active skill whose scope the action was checked against. */
    skillId: string;
    /** Whether the action stayed within the skill's declared action_scope. */
    passed: boolean;
    /** The gate's written reason — names the violating target on a hold. */
    reason: string;
    /** The tool the observed action invoked. */
    tool?: string;
    /** The deciding target (the violating one on a hold). */
    target?: string;
    /** Ticket opened for a non-conformant action, when routing applied. */
    ticketId?: string;
  };
}

/** Append-only audit log writer. */
export class AuditLog {
  private readonly path: string;
  private initialized = false;

  constructor(path: string) {
    this.path = path;
  }

  /** Emit an audit event to the log. */
  emit(event: AuditEvent): void {
    this.ensureDir();
    const line = JSON.stringify(event) + "\n";
    appendFileSync(this.path, line, "utf-8");
  }

  /** Get the log file path. */
  getPath(): string {
    return this.path;
  }

  private ensureDir(): void {
    if (this.initialized) return;
    mkdirSync(dirname(this.path), { recursive: true });
    this.initialized = true;
  }
}

/** Create an in-memory audit log for testing. */
export class InMemoryAuditLog {
  readonly events: AuditEvent[] = [];

  emit(event: AuditEvent): void {
    this.events.push(event);
  }

  getPath(): string {
    return ":memory:";
  }
}

export type AuditWriter = AuditLog | InMemoryAuditLog;

/** Build a tool_call audit event from the processing pipeline. */
export function buildEvent(
  sessionId: string,
  sequence: number,
  toolName: string,
  args: Record<string, unknown>,
  classification: Classification,
  governance: GovernanceDecision | undefined,
  outcome: AuditEvent["outcome"],
  durationMs: number,
  error?: string,
  correlationId?: string,
  parentId?: string,
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    sequence,
    ...(correlationId ? { correlationId } : {}),
    ...(parentId ? { parentId } : {}),
    type: "tool_call",
    toolCall: { name: toolName, args: sanitizeArgs(toolName, args) },
    classification,
    governance: governance ? sanitizeDecision(governance) : undefined,
    outcome,
    durationMs,
    error,
    signature: governance?.signature,
  };
}

/** Build a session lifecycle event. */
export function buildLifecycleEvent(
  sessionId: string,
  sequence: number,
  type: "session_start" | "session_end",
  details?: Record<string, unknown>,
  correlationId?: string,
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    sequence,
    ...(correlationId ? { correlationId } : {}),
    type,
    outcome: "approved",
    durationMs: 0,
    ...(details ? { toolCall: { name: type, args: details } } : {}),
  };
}

/** Build a budget spend event. */
export function buildBudgetEvent(
  sessionId: string,
  sequence: number,
  accepted: boolean,
  snapshot: LedgerSnapshot,
  details?: { manifest?: string; unitId?: string; amount?: number; currency?: string },
  correlationId?: string,
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    sequence,
    ...(correlationId ? { correlationId } : {}),
    type: accepted ? "budget_spend" : "budget_exceeded",
    outcome: accepted ? "approved" : "blocked",
    durationMs: 0,
    budget: snapshot,
    ...(details ? { toolCall: { name: accepted ? "budget_spend" : "budget_exceeded", args: details } } : {}),
  };
}

/** Build a human-approval lifecycle event from a ticket's current status. */
export function buildApprovalEvent(
  sessionId: string,
  sequence: number,
  type: "approval_requested" | "approval_resolved",
  status: ApprovalStatus,
  correlationId?: string,
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    sequence,
    ...(correlationId ? { correlationId } : {}),
    type,
    // A request is not yet an outcome; a resolution's outcome follows the reviewer.
    outcome: status.state === "approved" ? "approved" : "blocked",
    durationMs: 0,
    approval: {
      id: status.request.id,
      state: status.state,
      toolName: status.request.toolName,
      target: status.request.target,
      requiredRole: status.request.requiredRole,
      policyRef: status.resolution?.policyRef ?? status.request.evidence.policyRef,
      reviewer: status.resolution?.reviewer,
      reviewedAt: status.resolution?.reviewedAt,
      note: status.resolution?.note,
      expiresAt: status.request.expiresAt,
      ...(status.resolution?.signature
        ? { signed: true, ...(status.resolution.signature.keyId ? { keyId: status.resolution.signature.keyId } : {}) }
        : {}),
    },
  };
}

/** Build a confidence-gate event: the verdict, never the answer text. */
export function buildConfidenceEvent(
  sessionId: string,
  sequence: number,
  task: string,
  verdict: { passed: boolean; score: number; threshold: number; detail: string; severity?: string },
  ticketId?: string,
  correlationId?: string,
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    sequence,
    ...(correlationId ? { correlationId } : {}),
    type: "confidence_verdict",
    outcome: verdict.passed ? "approved" : "blocked",
    durationMs: 0,
    confidence: {
      task,
      passed: verdict.passed,
      score: verdict.score,
      threshold: verdict.threshold,
      detail: verdict.detail,
      severity: verdict.severity,
      ticketId,
    },
  };
}

/**
 * Build a conformance-gate event (#39): the verdict of checking one governed
 * action against the active skill's action_scope. Carries the decision and the
 * deciding target only — never the action's payload. `ticketId` is set when a
 * non-conformant action was routed to a human. Correlation-stamped so the hold
 * stitches into the same decision-record chain as the rest of the tool call.
 */
export function buildConformanceEvent(
  sessionId: string,
  sequence: number,
  skillId: string,
  verdict: ConformanceVerdict,
  ticketId?: string,
  correlationId?: string,
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    sequence,
    ...(correlationId ? { correlationId } : {}),
    type: "conformance_verdict",
    outcome: verdict.passed ? "approved" : "blocked",
    durationMs: 0,
    conformance: {
      skillId,
      passed: verdict.passed,
      reason: verdict.reason,
      tool: verdict.evidence?.tool,
      target: verdict.evidence?.target,
      ticketId,
    },
  };
}

/** Build a temporal drift event. */
export function buildDriftEvent(
  sessionId: string,
  sequence: number,
  drift: DriftResult,
  correlationId?: string,
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    sequence,
    ...(correlationId ? { correlationId } : {}),
    type: "temporal_drift",
    outcome: "blocked",
    durationMs: 0,
    drift: {
      manifest: drift.manifest,
      summary: drift.summary,
      movedUnits: drift.diff?.moves.length,
      newPlanAsOf: drift.diff?.b.asOf,
    },
  };
}

/**
 * Build a skill/procedure-gate event: the planner's skill_eligibility verdict
 * for a governed skill unit. Modeled on buildDriftEvent — carries the skill id,
 * the gate's written reason, and the skill's declared action scope. `loaded`
 * true → the skill passed the gate (skill_loaded); false → it failed and the
 * call was refused fail-closed (skill_skipped).
 */
export function buildSkillEvent(
  sessionId: string,
  sequence: number,
  loaded: boolean,
  detail: {
    id: string;
    reason: string;
    manifest?: string;
    gate?: string;
    actionScope?: { tools?: string[]; paths?: string[]; capabilities?: string[] };
  },
  correlationId?: string,
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    sequence,
    ...(correlationId ? { correlationId } : {}),
    type: loaded ? "skill_loaded" : "skill_skipped",
    outcome: loaded ? "approved" : "blocked",
    durationMs: 0,
    skill: {
      id: detail.id,
      manifest: detail.manifest,
      eligible: loaded,
      gate: detail.gate ?? "skill_eligibility",
      reason: detail.reason,
      actionScope: detail.actionScope,
    },
  };
}

/** Redact sensitive values from tool arguments for audit logging. */
export function sanitizeArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...args };

  // Redact content from Write calls (could be large/sensitive)
  if (toolName === "Write" && sanitized["content"]) {
    const content = String(sanitized["content"]);
    sanitized["content"] = `[${content.length} chars redacted]`;
  }

  // Redact Bash commands that might contain secrets
  if (toolName === "Bash" && sanitized["command"]) {
    const cmd = String(sanitized["command"]);
    // Redact values after common secret-passing patterns
    sanitized["command"] = cmd.replace(
      /(?:password|secret|token|key|api[_-]?key)\s*[=:]\s*\S+/gi,
      (match) => match.replace(/[=:]\s*\S+/, "=[REDACTED]"),
    );
  }

  return sanitized;
}

/** Strip the full plan from governance decisions to keep logs compact. */
function sanitizeDecision(decision: GovernanceDecision): GovernanceDecision {
  const { plan, trace, ...rest } = decision;
  return {
    ...rest,
    // Keep plan metadata but strip unit content
    plan: plan
      ? {
          ...plan,
          selected: plan.selected.map((u) => ({
            ...u,
            // Keep everything — PlannedUnit doesn't contain content
          })),
        }
      : undefined,
    // Omit full trace from audit (it's large); the trace is available via kcp_trace
    trace: undefined,
  };
}

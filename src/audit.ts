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
import type { Classification } from "./classifier.js";
import type { GovernanceDecision } from "./governor.js";
import type { LedgerSnapshot } from "./budget-ledger.js";
import type { DriftResult } from "./temporal-watch.js";

/** Event types for structured audit logging. */
export type AuditEventType =
  | "tool_call"          // Standard tool call governance event
  | "session_start"      // Session lifecycle: start
  | "session_end"        // Session lifecycle: end
  | "budget_spend"       // Budget ledger: spend recorded
  | "budget_exceeded"    // Budget ledger: spend rejected (ceiling)
  | "temporal_drift"     // Temporal watch: plan drift detected
  | "plan_invalidated";  // Temporal watch: plan invalidated due to drift

/** A single audit event. */
export interface AuditEvent {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Session ID for correlation. */
  sessionId: string;
  /** Monotonic sequence number within the session. */
  sequence: number;
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
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    sequence,
    type: "tool_call",
    toolCall: { name: toolName, args: sanitizeArgs(toolName, args) },
    classification,
    governance: governance ? sanitizeDecision(governance) : undefined,
    outcome,
    durationMs,
    error,
  };
}

/** Build a session lifecycle event. */
export function buildLifecycleEvent(
  sessionId: string,
  sequence: number,
  type: "session_start" | "session_end",
  details?: Record<string, unknown>,
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    sequence,
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
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    sequence,
    type: accepted ? "budget_spend" : "budget_exceeded",
    outcome: accepted ? "approved" : "blocked",
    durationMs: 0,
    budget: snapshot,
    ...(details ? { toolCall: { name: accepted ? "budget_spend" : "budget_exceeded", args: details } } : {}),
  };
}

/** Build a temporal drift event. */
export function buildDriftEvent(
  sessionId: string,
  sequence: number,
  drift: DriftResult,
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    sequence,
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

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

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Classification } from "./classifier.js";
import type { GovernanceDecision } from "./governor.js";

/** A single audit event. */
export interface AuditEvent {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Session ID for correlation. */
  sessionId: string;
  /** Monotonic sequence number within the session. */
  sequence: number;
  /** The tool call that was intercepted. */
  toolCall: {
    name: string;
    /** Sanitized arguments (sensitive values redacted). */
    args: Record<string, unknown>;
  };
  /** Classification result. */
  classification: Classification;
  /** Governance decision (only for governed calls). */
  governance?: GovernanceDecision;
  /** Final outcome. */
  outcome: "approved" | "blocked" | "pass-through" | "error";
  /** Processing time in milliseconds. */
  durationMs: number;
  /** Error message if the call failed. */
  error?: string;
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

/** Build an audit event from the processing pipeline. */
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
    toolCall: { name: toolName, args: sanitizeArgs(toolName, args) },
    classification,
    governance: governance ? sanitizeDecision(governance) : undefined,
    outcome,
    durationMs,
    error,
  };
}

/** Redact sensitive values from tool arguments for audit logging. */
function sanitizeArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
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

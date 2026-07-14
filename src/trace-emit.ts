// Decision-trace emitter — POST a compact, content-free projection of a
// kcp-agent DecisionTrace to a kcp-dashboard `/trace` endpoint.
//
// This is the emit side of the thought-graph decision layer. It is:
//   - opt-in   — only fires when a dashboard URL is configured;
//   - fail-open — a POST never throws or blocks governance;
//   - content-free — unit ids, paths, gate names/verdicts, scores only. No
//     unit content, no intents, no command bodies.
//
// See kcp-dashboard docs/thought-graph-phase2.md for the wire contract.

import type { DecisionTrace } from "kcp-agent";

/** One unit's gate-cascade verdict in the wire event. */
export interface TraceEventUnit {
  id: string;
  path?: string;
  outcome: string;
  rejected_by?: string;
  score?: number;
  gates: Array<{ gate: string; verdict: "pass" | "fail"; detail?: string }>;
}

/** The compact wire event POSTed to the dashboard. */
export interface TraceEvent {
  kind: "decision_trace";
  session_id: string;
  ts: string;
  project?: string;
  manifest?: string;
  task: string;
  as_of?: string;
  selected: number;
  skipped: number;
  gate_summary: Array<{ gate: string; passed: number; failed: number }>;
  units: TraceEventUnit[];
}

/** Context the trace itself doesn't carry (session, project, source manifest). */
export interface TraceContext {
  sessionId: string;
  project?: string;
  manifest?: string;
  /** Override the timestamp (tests); defaults to now. */
  ts?: string;
}

/** Project a DecisionTrace into the compact, content-free wire event. */
export function toTraceEvent(trace: DecisionTrace, ctx: TraceContext): TraceEvent {
  const units: TraceEventUnit[] = trace.units.map((u) => ({
    id: u.id,
    ...(u.path ? { path: u.path } : {}),
    outcome: u.outcome,
    ...(u.rejectedBy ? { rejected_by: u.rejectedBy } : {}),
    ...(u.score !== undefined ? { score: u.score } : {}),
    gates: u.gates.map((g) => ({
      gate: g.gate,
      verdict: g.passed ? "pass" : "fail",
      ...(g.detail ? { detail: g.detail } : {}),
    })),
  }));

  return {
    kind: "decision_trace",
    session_id: ctx.sessionId,
    ts: ctx.ts ?? new Date().toISOString(),
    ...(ctx.project ? { project: ctx.project } : {}),
    ...(ctx.manifest ? { manifest: ctx.manifest } : {}),
    task: trace.task,
    ...(trace.asOf ? { as_of: trace.asOf } : {}),
    selected: units.filter((u) => u.outcome === "selected").length,
    skipped: units.filter((u) => u.outcome === "skipped").length,
    gate_summary: (trace.gateSummary ?? []).map((g) => ({
      gate: g.gate,
      passed: g.passed,
      failed: g.failed,
    })),
    units,
  };
}

/**
 * Fire-and-forget POST of a trace event to the dashboard. Never throws and
 * never blocks: governance must not depend on the dashboard being up.
 */
export function emitTrace(url: string, event: TraceEvent): void {
  try {
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }).catch(() => {
      /* fail-open: the dashboard is best-effort telemetry */
    });
  } catch {
    /* never throw — e.g. malformed URL — governance continues regardless */
  }
}

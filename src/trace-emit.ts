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
import { canonicalJSON } from "./canonical.js";
import { signEvidence, verifyEvidence, type EvidenceSignature } from "./resolution-signature.js";

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
  /**
   * Detached ed25519 signature over the trace's canonical bytes (see
   * {@link canonicalTraceEvent}), attached by {@link signTraceEvent}. Present
   * only on a signed trace; the signature commits to every other field, so a
   * tampered trace fails {@link verifyTraceEvent}.
   */
  signature?: EvidenceSignature;
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

// -- Signing the decision trace ----------------------------------------------
//
// The emitted trace is content-free evidence of how a plan was decided. Signing
// it makes that evidence tamper-evident: an auditor verifies the trace with the
// signer's public key, and any altered field breaks the signature. Reuses the
// harness's ed25519 key mechanism (resolution-signature.ts) — no new scheme.

/**
 * Canonical bytes a trace signature commits to: the event with its `signature`
 * field excluded (a signature never signs over itself) and every object key in
 * sorted order, so the same trace signs and verifies byte-for-byte regardless
 * of field construction order.
 */
export function canonicalTraceEvent(event: TraceEvent): string {
  const { signature: _signature, ...rest } = event;
  return canonicalJSON(rest);
}

/**
 * Sign a trace event with a PKCS8 PEM ed25519 private key, returning a copy of
 * the event with the detached signature attached. Reuses signEvidence — the
 * same key and primitives as signed resolutions and purchase receipts.
 */
export async function signTraceEvent(
  privatePem: string,
  event: TraceEvent,
  keyId?: string,
): Promise<TraceEvent> {
  const signature = await signEvidence(privatePem, canonicalTraceEvent(event), keyId);
  return { ...event, signature };
}

/**
 * Verify a signed trace event over its canonical bytes. Fail-closed: an
 * unsigned trace, a malformed signature, or one that does not verify against
 * the (optional) pinned keys all return false.
 */
export async function verifyTraceEvent(event: TraceEvent, trustedKeys?: string[]): Promise<boolean> {
  return verifyEvidence(canonicalTraceEvent(event), event.signature, trustedKeys);
}

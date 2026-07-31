// §17 observability wire format — KCP v0.32.1 / RFC-0030.
//
// The spec's §17 `prohibited_attempt_events` table became normative in v0.32.1:
// where transmission is consented (e.g. a dashboard `/trace` sink), a
// prohibited attempt travels as a JSON object with `kind: "prohibited_attempt"`
// and the table's column names, and an emitter and an ingester are conformant
// when the canonical fixture
// (`conformance/fixtures/observability/prohibited-attempt.json`) round-trips
// between them.
//
// The internal hash-chained audit event (audit.ts) is NOT that object and must
// never become it: its shape is pinned by the chain — every entry's bytes are
// committed to by its successor — so it cannot bend to a sink's contract. This
// module is the PROJECTION from the internal record to the wire object. It
// takes the audit event AND the conformance verdict it was built from, because
// two §17 fields live only on the verdict: `matched_pattern` (the deny entry
// that fired — the gate knows it; the chained event records only the token)
// and `step_id` (the playbook step the caller named in the PlaybookContext).
//
// Nullable §17 fields are present-but-null, never omitted — an ingester keys
// on the full field set.

import type { AuditEvent } from "./audit.js";
import type { ConformanceVerdict } from "./conformance.js";

/**
 * The §17 `prohibited_attempt` wire object — field names and shapes exactly as
 * the spec's canonical fixture pins them.
 */
export interface ProhibitedAttemptWire {
  kind: "prohibited_attempt";
  /** The internal audit event's ISO 8601 timestamp, carried verbatim. */
  timestamp: string;
  /** The `kind: skill` unit whose enactment was refused. */
  unit_id: string;
  /** The enclosing playbook context; null when refused outside any playbook. */
  playbook_id: string | null;
  /** The executing playbook step; null likewise. */
  step_id: string | null;
  /** The deny dimension the token matched on. */
  dimension: "tools" | "paths" | "capabilities";
  /** The requested tool, path, or capability. */
  token: string;
  /** The deny entry that matched — differs from `token` when a path glob fires. */
  matched_pattern: string;
  /** The deny source(s) that fired, folded into the §17 enum. */
  binding_source: "skill" | "playbook" | "both";
  /**
   * Always null at emission: acknowledgement is an ingester-side act (a human
   * at the sink), records acknowledgement ONLY, and MUST NOT enact — deny
   * finality (§4.3b). The emitter has nothing truthful to put here.
   */
  acknowledged_by: string | null;
  /** The decision-record chain id; null when the event carries none. */
  correlation_id: string | null;
}

/**
 * Project an internal prohibited_attempt audit event onto the §17 wire object.
 *
 * `verdict` must be the very ConformanceVerdict the event was built from
 * (buildProhibitedAttemptEvent) — it supplies `matched_pattern` and `step_id`,
 * which the chained event deliberately does not record. Fail-closed: the
 * projection throws rather than emit a wire object it cannot fill faithfully —
 * a non-prohibited event, a verdict without a deny-hit, or a pair that does
 * not describe the same refusal.
 */
export function toProhibitedAttemptWire(
  event: AuditEvent,
  verdict: ConformanceVerdict,
): ProhibitedAttemptWire {
  const p = event.prohibited;
  if (event.type !== "prohibited_attempt" || !p) {
    throw new Error(
      `toProhibitedAttemptWire: event is not a prohibited_attempt (type "${event.type}") — refusing to project`,
    );
  }
  const vp = verdict.prohibited;
  if (!vp) {
    throw new Error(
      "toProhibitedAttemptWire: verdict carries no prohibited detail — not the deny-hit this event records",
    );
  }
  if (vp.token !== p.token || vp.dimension !== p.dimension) {
    throw new Error(
      `toProhibitedAttemptWire: event/verdict mismatch — event refused ${p.dimension} "${p.token}", ` +
        `verdict refused ${vp.dimension} "${vp.token}"; the wire must never stitch two refusals together`,
    );
  }
  const sources = p.bindingSources;
  if (sources.length === 0) {
    throw new Error(
      "toProhibitedAttemptWire: event names no binding source — refusing to project a malformed prohibition",
    );
  }

  return {
    kind: "prohibited_attempt",
    timestamp: event.timestamp,
    unit_id: p.skillId,
    playbook_id: p.playbookId ?? vp.playbookId ?? null,
    step_id: vp.stepId ?? null,
    dimension: p.dimension,
    token: p.token,
    matched_pattern: vp.matchedPattern,
    binding_source: sources.length > 1 ? "both" : sources[0],
    acknowledged_by: null,
    correlation_id: event.correlationId ?? null,
  };
}

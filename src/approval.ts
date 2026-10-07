// Approval — pending governance decisions resolved by a named human.
//
// Some governed actions must not be decided by the automated gate cascade
// alone: org policy demands a named human sign off, and that can take
// minutes or days. This module is the state machine for those decisions:
//
//   pending_review ─▶ approved   (by a named reviewer — a BOUNDED grant, see below)
//          │                └───▶ used     (terminal: a `once` grant consumed by a call)
//          │────────▶ dismissed  (terminal, by a named reviewer)
//          └────────▶ expired    (terminal, via TTL — fail-closed)
//
// An approval is the scope of ONE human decision, never a standing permission (a
// standing permission is a policy rule, not a click). An approved ticket is a grant that is
// bound to the session that opened it, to the exact (tool, target) and to the call's
// arguments digest, and it lapses: `once` (consumed by the first matching call), `session`
// or a duration — always capped by `grant_max`. See evaluateGrant / resolveGrant below.
//
// Two invariants, from the governance pilot this design serves:
// 1. A resolution REQUIRES a named reviewer and a policy reference —
//    `approved: true` alone is not a valid resolution. Evidence is
//    generated at approval time, never reconstructed from logs later.
// 2. Approvals must survive process restart: sessions are ephemeral,
//    human review is not. The FileApprovalProvider persists every ticket.
//
// The provider interface is deliberately channel-agnostic — Slack, email,
// or ticketing integrations are org-side implementations of the same
// submit/check/resolve/list surface the built-in file provider ships.

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_APPROVALS_DIR, type ApprovalsConfig } from "./config.js";
import {
  canonicalResolutionPayload,
  verifyResolutionSignature,
  type ResolutionSignature,
} from "./resolution-signature.js";
import { canonicalJSON } from "./canonical.js";
import type { ConfidenceVerdict } from "kcp-agent";
import type { ConformanceVerdict } from "./conformance.js";

/** Lifecycle states for an approval ticket. */
export type ApprovalState = "pending_review" | "approved" | "dismissed" | "expired" | "used";

/** How long an approval authorises calls. */
export type GrantMode = "once" | "session" | "duration";

/** The grant scope stamped on a ticket when it is opened (from the rule's `grant`). */
export interface GrantSpec {
  mode: GrantMode;
  /** For `duration`: how long after the resolution the grant is valid, in ms. */
  durationMs?: number;
}

/** Default hard maximum validity of any approval (never permanent). */
export const DEFAULT_GRANT_MAX = "24h";

/** Record that a `once` grant was consumed by a call. */
export interface ApprovalUse {
  /** Ticket id. */
  id: string;
  /** Session of the call that consumed the grant. */
  sessionId: string;
  /** Correlation id of the call that consumed it, when the call carried one. */
  correlationId?: string;
  usedAt: string;
  /** Claim token — lets concurrent consumers learn which claim won. */
  token: string;
}

/** A request for human approval of a governed call. */
export interface ApprovalRequest {
  /** Ticket id, assigned by the harness. */
  id: string;
  /** Session that triggered the request. */
  sessionId: string;
  /** The intercepted tool call. */
  toolName: string;
  /** The classified target (path / action). */
  target: string;
  /** The task context the call was made under. */
  task: string;
  /** Role that must approve, from harness policy (e.g. "account-owner"). */
  requiredRole: string;
  /** ISO timestamp the ticket was opened. */
  requestedAt: string;
  /**
   * The action this ticket is about, as a correlation id (#34).
   *
   * `sessionId` names a session, which holds many actions; this names the one a human is
   * being asked to sign off. Without it, "which action did this person approve?" is
   * answerable only by cross-referencing the audit event that wrapped the request — which
   * holds while ticket and log sit together, and stops the moment a ticket is exported or
   * read on its own, exactly when an auditor is looking at it.
   *
   * Absent when the intercepted call carried no traceparent. Never invented: a ticket
   * claiming to belong to a chain that does not exist is worse than one standing alone.
   */
  correlationId?: string;
  /** ISO timestamp after which an unresolved ticket reads as expired. */
  expiresAt?: string;
  /**
   * Scope of the grant an approval of this ticket confers. Absent on tickets written before
   * grants existed — those are treated as `session` scoped (see evaluateGrant).
   */
  grant?: GrantSpec;
  /**
   * Digest of the intercepted call's arguments (see argsDigest). When present the grant only
   * covers a call with the same digest. Absent on legacy tickets and on tickets opened by
   * paths with no call arguments (e.g. harness_assess).
   */
  argsDigest?: string;
  /**
   * `false` when this ticket deliberately carries no `argsDigest` — the call has no arguments
   * to bind (see `argsUnboundReason`). Every ticket opened by a current harness carries either
   * an `argsDigest` or `argsBound: false` with a reason; a ticket with neither is a LEGACY ticket
   * written before binding was explicit. An unbound grant covers the exact (tool, target) only
   * and is refused outright when `approvals.require_args_binding` is on (see evaluateGrant).
   */
  argsBound?: false;
  /**
   * Why the ticket is unbound. `no_call_arguments`: the gated object has no call arguments
   * (harness_assess — the task text IS the target). `not_supplied`: a caller built the ticket
   * without a digest and did not say why.
   */
  argsUnboundReason?: string;
  /** Evidence generated at request time — why a human is being asked. */
  evidence: {
    manifest?: string;
    /** The policy rule that demanded human sign-off. */
    policyRef?: string;
    detail?: string;
    /** The failed confidence verdict, when the gate routed here. */
    confidence?: ConfidenceVerdict;
    /** The failed procedural conformance verdict, when the gate routed here (#39). */
    conformance?: ConformanceVerdict;
  };
}

/** A named human's resolution of a ticket. */
export interface ApprovalResolution {
  id: string;
  state: "approved" | "dismissed";
  /** Named reviewer — required, never anonymous. */
  reviewer: string;
  /**
   * When the reviewer says they decided. REVIEWER-SUPPLIED: display and evidence only — never
   * the clock a grant's validity is measured from (see `resolvedAtStore`).
   */
  reviewedAt: string;
  /**
   * When the STORE accepted the resolution, from the provider's own clock. Stamped by the
   * provider in resolve(), overwriting anything the caller sent. A grant's window (`once` /
   * `session` / duration, always capped by `grant_max`) is measured from this time. Absent on
   * resolutions written before the stamp existed (see {@link trustedResolutionTime}).
   */
  resolvedAtStore?: string;
  /** Policy/regulatory citation satisfied — required at approval time. */
  policyRef: string;
  note?: string;
  /**
   * Optional ed25519 signature over the resolution's canonical payload —
   * non-repudiable proof the operator holds the named reviewer's key. Required
   * when `approvals.require_signed_resolutions` is on (fail-closed otherwise).
   */
  signature?: ResolutionSignature;
}

/** Current status of a ticket: its request, computed state, and resolution. */
export interface ApprovalStatus {
  state: ApprovalState;
  request: ApprovalRequest;
  resolution?: ApprovalResolution;
  /** Present when a `once` grant has been consumed (state is then "used"). */
  use?: ApprovalUse;
  /**
   * Records in the store that were READ but not honoured, in log order: a resolution that is
   * unsigned / badly signed under `require_signed_resolutions`, future-dated, older than the
   * ticket, malformed, or any record after the ticket's first terminal resolution.
   */
  ignored?: IgnoredRecord[];
  /**
   * The trusted time (ISO) the resolution's grant window is measured from: the store's own
   * stamp, or for a legacy resolution min(reviewedAt, store file mtime, now). Present when the
   * ticket has a resolution. A custom provider may omit it; evaluateGrant then falls back to a
   * guarded reading of `reviewedAt`.
   */
  trustedResolvedAt?: string;
  /** True when `trustedResolvedAt` had to fall back to the legacy rule (no store stamp). */
  legacyTime?: boolean;
}

/** Why a stored record was read but not honoured. */
export type IgnoredReason =
  | "unsigned"        // require_signed_resolutions is on and the record carries no signature
  | "bad_signature"   // ... or its signature does not verify (wrong key / altered fields)
  | "future_dated"    // reviewedAt (or the store stamp) is further ahead than the allowed skew
  | "before_request"  // reviewedAt is earlier than the ticket's requestedAt
  | "malformed"       // missing reviewer / policyRef / state / parsable dates
  | "after_expiry"    // the resolution's trusted time is after the ticket's expiresAt
  | "extra_record";   // a second resolution for a ticket that already has a terminal one

/** One record the store read but did not honour. */
export interface IgnoredRecord {
  reason: IgnoredReason;
  state?: "approved" | "dismissed";
  reviewer?: string;
  reviewedAt?: string;
}

/** Reasons that make a resolution INVALID (audited as grant_denied `invalid`), vs. merely extra. */
const INVALID_RESOLUTION_REASONS: ReadonlySet<IgnoredReason> = new Set([
  "unsigned", "bad_signature", "future_dated", "before_request", "malformed",
]);

/** Does this status carry an ignored record that made a resolution invalid? */
export function hasInvalidResolution(status: ApprovalStatus): boolean {
  return (status.ignored ?? []).some((r) => INVALID_RESOLUTION_REASONS.has(r.reason));
}

/** How a ticket binds to call arguments. */
export type ArgsBinding = "bound" | "unbound" | "legacy";

/**
 * `bound`: carries an argsDigest. `unbound`: explicit `argsBound: false`. `legacy`: neither —
 * written before binding was explicit; treated as unbound under the old rule.
 */
export function argsBindingOf(request: ApprovalRequest): ArgsBinding {
  if (request.argsDigest) return "bound";
  return request.argsBound === false ? "unbound" : "legacy";
}

/**
 * The channel-agnostic provider surface. The harness submits and checks;
 * the approval channel (CLI, Slack bot, ticketing system) resolves.
 */
export interface ApprovalProvider {
  submit(req: ApprovalRequest): Promise<void>;
  check(id: string): Promise<ApprovalStatus | undefined>;
  resolve(res: ApprovalResolution): Promise<ApprovalStatus>;
  list(filter?: { state?: ApprovalState }): Promise<ApprovalStatus[]>;
  /**
   * Atomically consume a `once` grant: resolves true for exactly one caller per ticket, and the
   * ticket then reads as "used". Optional on the interface so existing custom providers still
   * compile — but a provider without it cannot enforce `once`, so the governor FAILS CLOSED
   * (denies) for `once` grants against it.
   */
  consume?(use: Omit<ApprovalUse, "token" | "usedAt">): Promise<boolean>;
}

/**
 * Signature policy handed to a provider at construction. Enforcement lives at
 * resolve() time — the one point every channel funnels through — so no channel
 * can accept an unsigned resolution when the org requires signed ones.
 */
export interface SignaturePolicy {
  /** Require a valid ed25519 signature on every resolution (fail-closed). */
  requireSigned?: boolean;
  /** Trusted reviewer keys (paths or inline material) that bind identity. */
  trustedKeys?: string[];
}

/** Default tolerated clock skew for a reviewer-supplied `reviewedAt` (and the store stamp). */
export const DEFAULT_REVIEW_SKEW = "5m";

/** Store options handed to a provider at construction. */
export interface StoreOptions {
  /**
   * How far ahead of the store's clock a resolution's `reviewedAt` may be before the resolution
   * is refused (resolve) or ignored (read). Default 5 minutes.
   */
  maxSkewMs?: number;
}

/** Construct the configured ticket store. */
export function providerFromConfig(config: ApprovalsConfig): ApprovalProvider {
  const sig: SignaturePolicy = {
    requireSigned: config.require_signed_resolutions === true,
    trustedKeys: config.trusted_keys,
  };
  const opts: StoreOptions = { maxSkewMs: parseDuration(config.max_reviewed_at_skew ?? DEFAULT_REVIEW_SKEW) };
  if (config.provider === "memory") return new InMemoryApprovalProvider(sig, opts);
  return new FileApprovalProvider(config.dir ?? DEFAULT_APPROVALS_DIR, sig, opts);
}

/**
 * A deny is never grantable (RFC-0030 / KCP 0.32, §4.3b). An approval ticket is
 * a request for permission, and a deny-hit is not a question: the action is
 * refused finally and the escalation raised is a notify-only prohibited-attempt
 * event. This guard makes the refusal structural — enforced at newRequest AND at
 * every provider's submit(), so no channel can store a grantable ticket for a
 * prohibited action, whatever built the request. The only way past a deny is a
 * new, reviewed, signed manifest version that no longer declares it.
 */
function assertGrantable(req: Omit<ApprovalRequest, "id" | "requestedAt"> | ApprovalRequest): void {
  if (req.evidence?.conformance?.prohibited) {
    const p = req.evidence.conformance.prohibited;
    throw new Error(
      `a deny is never grantable (RFC-0030): refusing to open an approval ticket for ` +
        `${p.dimension} "${p.token}" held by ${p.bindingSources.join(" and ")} deny — ` +
        `a deny-hit raises a notify-only prohibited_attempt event, not a request for permission`,
    );
  }
}

/** Build a new ticket with id + requestedAt assigned. */
export function newRequest(
  fields: Omit<ApprovalRequest, "id" | "requestedAt"> & { expiresAt?: string },
): ApprovalRequest {
  assertGrantable(fields);
  // Binding is always explicit on a new ticket: a digest, or `argsBound: false` with a reason.
  const binding: Partial<ApprovalRequest> = fields.argsDigest
    ? {}
    : { argsBound: false, argsUnboundReason: fields.argsUnboundReason ?? "not_supplied" };
  return {
    id: randomUUID(),
    requestedAt: new Date().toISOString(),
    ...fields,
    ...binding,
  };
}

/** Parse a policy duration ("72h", "30m", "7d") to milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+)([mhd])$/.exec(text.trim());
  if (!m) throw new Error(`invalid duration "${text}" — expected <number><m|h|d>, e.g. "72h"`);
  const n = Number(m[1]);
  const unit = m[2] === "m" ? 60_000 : m[2] === "h" ? 3600_000 : 24 * 3600_000;
  return n * unit;
}

/**
 * Find the most recent ticket for a (target, tool) pair, whatever its state and session.
 *
 * NOT a grant check: it ignores session, argument binding and grant expiry. Do not use its
 * result to decide that a call is approved — use {@link resolveGrant}. Kept for read-only
 * callers (status displays) and API compatibility.
 */
export async function latestForCall(
  provider: ApprovalProvider,
  target: string,
  toolName: string,
): Promise<ApprovalStatus | undefined> {
  const all = await provider.list();
  const matching = all.filter(
    (s) => s.request.target === target && s.request.toolName === toolName,
  );
  return matching[matching.length - 1];
}

// -- Grants: what an approval actually authorises ----------------------------

/** Why a call was refused despite an approved ticket existing for its (tool, target). */
export type GrantDenyReason =
  | "expired"        // grant lapsed (duration, or the grant_max cap)
  | "wrong_session"  // approved for another session
  | "used"           // a `once` grant was already consumed
  | "args_mismatch"  // ticket is bound to different call arguments
  | "invalid";       // grant could not be evaluated — corrupt ticket / unsupported provider (fail-closed)

/** Parse a rule's `grant` setting: "once" | "session" | a duration ("15m", "4h", "1d"). */
export function parseGrantSetting(setting: string | undefined): GrantSpec {
  if (setting === undefined) return { mode: "session" };
  const text = setting.trim();
  if (text === "once") return { mode: "once" };
  if (text === "session") return { mode: "session" };
  return { mode: "duration", durationMs: parseDuration(text) };
}

/** The hard maximum validity of any approval, in ms (default 24h). Throws on a bad value. */
export function grantMaxMs(setting?: string): number {
  return parseDuration(setting ?? DEFAULT_GRANT_MAX);
}

/**
 * Digest of a call's arguments, used to bind a grant to what was actually asked for.
 * Correlation carriers (`traceparent`, `_meta`) are excluded — they differ on every call.
 * Key order does not matter (canonical JSON).
 */
export function argsDigest(args: Record<string, unknown>): string {
  const { traceparent: _t, _meta: _m, ...rest } = args;
  return "sha256:" + createHash("sha256").update(canonicalJSON(rest)).digest("hex");
}

/** The call a grant is being evaluated against. */
export interface GrantQuery {
  target: string;
  toolName: string;
  sessionId: string;
  /** Digest of the call's arguments, when available. */
  argsDigest?: string;
  /** Hard maximum validity in ms. */
  maxMs: number;
  /** Correlation id of the call (recorded on a consumed `once` grant). */
  correlationId?: string;
  /**
   * Refuse a grant from a ticket that is not bound to the call's arguments (default false, for
   * compatibility with tickets written before binding was explicit; recommended true).
   * A ticket whose `argsUnboundReason` is `no_call_arguments` is exempt: the call has no
   * arguments, so (tool, target) is the whole call and there is nothing to bind.
   */
  requireArgsBinding?: boolean;
  /** Tolerated reviewedAt skew for statuses without a store stamp (default 5 min). */
  maxSkewMs?: number;
  now?: number;
}

/**
 * Is an approved ticket a valid grant for this call? Pure and fail-closed: anything that
 * cannot be positively evaluated (missing/garbled dates, missing session ids, unknown grant
 * mode) is a denial with reason "invalid", never an approval.
 *
 * The grant window is measured from the TRUSTED resolution time (`status.trustedResolvedAt`,
 * stamped by the store), never from the reviewer-supplied `reviewedAt`. For a status without
 * it (a custom provider) `reviewedAt` is used only if it is not in the future beyond the skew.
 *
 * Legacy tickets (approved before grants existed — no `request.grant`) are treated as
 * `session` scoped by `request.sessionId` and expire at the resolution time + grant_max.
 *
 * Argument binding: a bound ticket covers only a call with the same digest. An unbound ticket
 * (explicit `argsBound: false`) covers the exact (tool, target) and only for `once` / `session`
 * grants. A legacy ticket (no digest, no flag) keeps the pre-binding rule. With
 * `requireArgsBinding` neither is a grant (see {@link GrantQuery.requireArgsBinding}).
 */
export function evaluateGrant(
  status: ApprovalStatus,
  q: GrantQuery,
): { ok: true } | { ok: false; reason: GrantDenyReason; detail?: string } {
  try {
    if (status.state === "used") return { ok: false, reason: "used" };
    if (status.state !== "approved" || !status.resolution) return { ok: false, reason: "invalid" };
    if (!q.sessionId || !status.request.sessionId) return { ok: false, reason: "invalid" };
    if (!Number.isFinite(q.maxMs) || q.maxMs <= 0) return { ok: false, reason: "invalid" };

    const now = q.now ?? Date.now();
    let resolvedAt: number;
    if (status.trustedResolvedAt !== undefined) {
      resolvedAt = Date.parse(status.trustedResolvedAt);
    } else {
      resolvedAt = Date.parse(status.resolution.reviewedAt);
      const skew = q.maxSkewMs ?? parseDuration(DEFAULT_REVIEW_SKEW);
      if (Number.isFinite(resolvedAt) && resolvedAt > now + skew) {
        return { ok: false, reason: "invalid", detail: "future_dated" };
      }
    }
    if (!Number.isFinite(resolvedAt)) return { ok: false, reason: "invalid" };

    const grant = status.request.grant ?? { mode: "session" as const };
    let windowMs = q.maxMs;
    if (grant.mode === "duration") {
      if (!Number.isFinite(grant.durationMs) || (grant.durationMs as number) <= 0) {
        return { ok: false, reason: "invalid" };
      }
      windowMs = Math.min(grant.durationMs as number, q.maxMs);
    } else if (grant.mode !== "once" && grant.mode !== "session") {
      return { ok: false, reason: "invalid" };
    }

    if (status.request.sessionId !== q.sessionId) return { ok: false, reason: "wrong_session" };

    const binding = argsBindingOf(status.request);
    if (binding === "bound") {
      if (status.request.argsDigest !== q.argsDigest) return { ok: false, reason: "args_mismatch" };
    } else {
      const structural = status.request.argsUnboundReason === "no_call_arguments";
      if (q.requireArgsBinding && !structural) {
        return { ok: false, reason: "invalid", detail: "args_unbound" };
      }
      // An explicitly unbound ticket (new) is limited to once / session; a duration is not
      // honoured. A legacy ticket keeps its pre-binding behaviour (documented migration).
      if (binding === "unbound" && grant.mode === "duration") {
        return { ok: false, reason: "invalid", detail: "args_unbound_duration" };
      }
    }

    if (now >= resolvedAt + windowMs) return { ok: false, reason: "expired" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** Records the store read for a ticket but did not honour — for the caller to audit. */
export interface IgnoredReport {
  ticketId: string;
  records: IgnoredRecord[];
}

/** A denied approval: why, which ticket, and (when useful) a finer-grained detail. */
export interface GrantDenied {
  reason: GrantDenyReason;
  ticketId?: string;
  detail?: string;
}

/** An unbound ticket was used as a grant (audited as `grant_unbound`). */
export interface UnboundGrant {
  ticketId: string;
  binding: "unbound" | "legacy";
  reason?: string;
}

/** Outcome of looking for a grant that covers a call. */
export type GrantOutcome =
  /** A valid grant covers the call (a `once` grant has been consumed by it). */
  | { kind: "granted"; status: ApprovalStatus; unbound?: UnboundGrant; ignored?: IgnoredReport }
  /** A ticket for this session is awaiting a human. `denied` is set when a resolution was ignored as invalid. */
  | { kind: "pending"; status: ApprovalStatus; denied?: GrantDenied; ignored?: IgnoredReport }
  /** This session's newest ticket was dismissed — terminal. */
  | { kind: "dismissed"; status: ApprovalStatus; ignored?: IgnoredReport }
  /** No usable ticket: the caller should open a new one. `denied` says why an approval was refused. */
  | { kind: "open"; previous?: ApprovalStatus; denied?: GrantDenied; ignored?: IgnoredReport }
  /** The call cannot be matched to any session (missing sessionId): deny, open nothing. */
  | { kind: "invalid"; denied: { reason: "invalid" } };

/**
 * Decide whether an existing ticket authorises this call.
 *
 * Only tickets for the SAME session, tool, target (and args digest, when the ticket has one)
 * are considered, and the NEWEST of those decides — an older approval never outlives a newer
 * dismissal, and a newer pending ticket is not bypassed by an older approval. An approval from
 * another session is never reused (reason wrong_session) and neither is an expired or used one;
 * the caller opens a fresh ticket instead.
 *
 * A resolution the store read but found invalid (unsigned under require_signed_resolutions,
 * future-dated, ...) is not an approval: the ticket reads as still pending, and the outcome
 * carries `denied: { reason: "invalid" }` so the caller can audit the refusal.
 */
export async function resolveGrant(provider: ApprovalProvider, q: GrantQuery): Promise<GrantOutcome> {
  if (!q.sessionId) return { kind: "invalid", denied: { reason: "invalid" } };
  const all = await provider.list();
  const candidates = all.filter(
    (s) =>
      s.request.target === q.target &&
      s.request.toolName === q.toolName &&
      // A ticket bound to a digest only matches a call with that digest. Unbound / legacy
      // tickets (no digest) match the exact (tool, target) whatever the arguments — evaluateGrant
      // then limits them (once/session only) or refuses them (require_args_binding).
      (!s.request.argsDigest || s.request.argsDigest === q.argsDigest),
  );
  const mine = candidates.filter((s) => s.request.sessionId === q.sessionId);
  const newest = mine[mine.length - 1];

  if (!newest) {
    const foreign = [...candidates].reverse().find((s) => s.state === "approved" || s.state === "used");
    return foreign
      ? { kind: "open", denied: { reason: "wrong_session", ticketId: foreign.request.id } }
      : { kind: "open" };
  }

  const ignored: { ignored?: IgnoredReport } = newest.ignored?.length
    ? { ignored: { ticketId: newest.request.id, records: newest.ignored } }
    : {};
  const invalidDenied: { denied?: GrantDenied } = hasInvalidResolution(newest)
    ? { denied: { reason: "invalid", ticketId: newest.request.id, detail: "resolution_ignored" } }
    : {};

  if (newest.state === "pending_review") return { kind: "pending", status: newest, ...invalidDenied, ...ignored };
  if (newest.state === "dismissed" && newest.resolution) return { kind: "dismissed", status: newest, ...ignored };
  if (newest.state === "expired") return { kind: "open", previous: newest, ...invalidDenied, ...ignored };

  // approved | used (anything else is not understood → fail closed)
  const verdict = evaluateGrant(newest, q);
  if (!verdict.ok) {
    return {
      kind: "open",
      previous: newest,
      denied: { reason: verdict.reason, ticketId: newest.request.id, ...(verdict.detail ? { detail: verdict.detail } : {}) },
      ...ignored,
    };
  }
  if ((newest.request.grant?.mode ?? "session") === "once") {
    if (!provider.consume) {
      return { kind: "open", previous: newest, denied: { reason: "invalid", ticketId: newest.request.id }, ...ignored };
    }
    const won = await provider.consume({
      id: newest.request.id,
      sessionId: q.sessionId,
      ...(q.correlationId ? { correlationId: q.correlationId } : {}),
    });
    if (!won) {
      return { kind: "open", previous: newest, denied: { reason: "used", ticketId: newest.request.id }, ...ignored };
    }
  }
  const binding = argsBindingOf(newest.request);
  return {
    kind: "granted",
    status: newest,
    ...(binding !== "bound"
      ? {
          unbound: {
            ticketId: newest.request.id,
            binding,
            ...(newest.request.argsUnboundReason ? { reason: newest.request.argsUnboundReason } : {}),
          },
        }
      : {}),
    ...ignored,
  };
}

// -- Shared state-machine core ----------------------------------------------

/** Compute the effective state, applying TTL expiry to unresolved tickets. */
function effectiveState(
  request: ApprovalRequest,
  resolution?: ApprovalResolution,
  use?: ApprovalUse,
): ApprovalState {
  if (resolution) return resolution.state === "approved" && use ? "used" : resolution.state;
  if (request.expiresAt && Date.parse(request.expiresAt) < Date.now()) return "expired";
  return "pending_review";
}

function validateResolution(res: ApprovalResolution): void {
  if (!res.reviewer?.trim()) throw new Error("approval resolution requires a named reviewer");
  if (!res.policyRef?.trim()) {
    throw new Error("approval resolution requires a policyRef — approved alone is not evidence");
  }
}

/** The signature payload for a resolution of a ticket. */
function signaturePayload(request: ApprovalRequest, res: ApprovalResolution) {
  return {
    id: res.id,
    target: request.target,
    tool: request.toolName,
    state: res.state,
    reviewer: res.reviewer,
    policyRef: res.policyRef,
    timestamp: res.reviewedAt,
  };
}

/**
 * Enforce the signature policy at resolution time. Fail-closed: when the org
 * requires signed resolutions, a missing or invalid signature is not a valid
 * resolution and the resolve throws. When the flag is off, behavior is
 * unchanged — a signature, if present, is stored verbatim but not required.
 *
 * The same check runs again on the READ path (see {@link checkStoredResolution}), so a record
 * appended to the store without going through resolve() gets no further than one resolve() would.
 */
async function enforceSignature(
  request: ApprovalRequest,
  res: ApprovalResolution,
  policy: SignaturePolicy | undefined,
): Promise<void> {
  if (!policy?.requireSigned) return;
  if (!res.signature) {
    throw new Error(
      `approval resolution ${res.id} requires a signature — require_signed_resolutions is on`,
    );
  }
  const ok = await verifyResolutionSignature(signaturePayload(request, res), res.signature, policy.trustedKeys);
  if (!ok) {
    throw new Error(
      `approval resolution ${res.id} has an invalid signature — fail-closed, not resolving`,
    );
  }
}

/** The canonical payload a reviewer signs for a given ticket + resolution. */
export function resolutionPayload(request: ApprovalRequest, res: ApprovalResolution): string {
  return canonicalResolutionPayload(signaturePayload(request, res));
}

/** Check a ticket is resolvable; throws with the reason if not. */
function assertResolvable(status: ApprovalStatus | undefined, id: string): asserts status is ApprovalStatus {
  if (!status) throw new Error(`unknown approval ticket: ${id}`);
  if (status.state === "expired") throw new Error(`approval ticket ${id} has expired`);
  if (status.state !== "pending_review") {
    throw new Error(`approval ticket ${id} is already resolved (${status.state}) — terminal states are terminal`);
  }
}

/** Context a stored resolution is judged in. */
interface JudgeContext {
  now: number;
  skewMs: number;
  policy?: SignaturePolicy;
}

/**
 * The time a resolution's grant window is measured from.
 *
 *  - Stamped by the store (`resolvedAtStore`): that stamp, clamped to now.
 *  - Legacy (no stamp, written by an older harness): min(reviewedAt, mtime of the store file,
 *    now). The mtime is an UPPER bound only — the file may have been written to since — but it
 *    is the store's own clock, so a reviewer-supplied future `reviewedAt` can no longer start
 *    a window later than the last time the file was touched. Never later than now.
 */
export function trustedResolutionTime(
  res: ApprovalResolution,
  now: number,
  fileMtimeMs?: number,
): { ms: number; legacy: boolean } {
  const reviewed = Date.parse(res.reviewedAt);
  // An unreadable reviewedAt is a corrupt record whatever the stamp says: fail closed.
  if (!Number.isFinite(reviewed)) return { ms: Number.NaN, legacy: res.resolvedAtStore === undefined };
  if (res.resolvedAtStore !== undefined) {
    return { ms: Math.min(Date.parse(res.resolvedAtStore), now), legacy: false };
  }
  const candidates = [reviewed, now];
  if (fileMtimeMs !== undefined && Number.isFinite(fileMtimeMs)) candidates.push(fileMtimeMs);
  return { ms: Math.min(...candidates), legacy: true };
}

/**
 * Judge one resolution record against its ticket: is it a resolution the store may honour?
 * Returns the reason it must be ignored, or undefined when it is acceptable. Used by resolve()
 * (to refuse) and by every read (to ignore) so both paths hold the same line.
 */
async function checkStoredResolution(
  request: ApprovalRequest,
  res: ApprovalResolution,
  ctx: JudgeContext,
  fileMtimeMs?: number,
): Promise<IgnoredReason | undefined> {
  if (
    !res ||
    (res.state !== "approved" && res.state !== "dismissed") ||
    typeof res.reviewer !== "string" || !res.reviewer.trim() ||
    typeof res.policyRef !== "string" || !res.policyRef.trim()
  ) return "malformed";

  const reviewedAt = Date.parse(res.reviewedAt);
  if (!Number.isFinite(reviewedAt)) return "malformed";

  let storeTime = ctx.now;
  if (res.resolvedAtStore !== undefined) {
    storeTime = Date.parse(res.resolvedAtStore);
    if (!Number.isFinite(storeTime)) return "malformed";
    if (storeTime > ctx.now + ctx.skewMs) return "future_dated";
  }
  if (reviewedAt > storeTime + ctx.skewMs) return "future_dated";

  const requestedAt = Date.parse(request.requestedAt);
  if (Number.isFinite(requestedAt) && reviewedAt < requestedAt) return "before_request";

  const trusted = trustedResolutionTime(res, ctx.now, fileMtimeMs).ms;
  if (request.expiresAt) {
    const expiresAt = Date.parse(request.expiresAt);
    if (Number.isFinite(expiresAt) && trusted > expiresAt) return "after_expiry";
  }

  if (ctx.policy?.requireSigned) {
    if (!res.signature) return "unsigned";
    const ok = await verifyResolutionSignature(signaturePayload(request, res), res.signature, ctx.policy.trustedKeys);
    if (!ok) return "bad_signature";
  }
  return undefined;
}

/**
 * Fold a ticket's resolution records (in log order) into its one effective resolution:
 * the FIRST record that passes {@link checkStoredResolution} wins; every later record is
 * `extra_record`; a record that fails is ignored with its reason and does not block a later,
 * valid one (a forged line must not be able to shut a legitimate reviewer out).
 */
async function foldResolutions(
  request: ApprovalRequest,
  records: ApprovalResolution[],
  ctx: JudgeContext,
  fileMtimeMs?: number,
): Promise<{ resolution?: ApprovalResolution; ignored: IgnoredRecord[] }> {
  let winner: ApprovalResolution | undefined;
  const ignored: IgnoredRecord[] = [];
  for (const rec of records) {
    const meta = {
      ...(rec?.state === "approved" || rec?.state === "dismissed" ? { state: rec.state } : {}),
      ...(typeof rec?.reviewer === "string" ? { reviewer: rec.reviewer } : {}),
      ...(typeof rec?.reviewedAt === "string" ? { reviewedAt: rec.reviewedAt } : {}),
    };
    if (winner) {
      ignored.push({ reason: "extra_record", ...meta });
      continue;
    }
    const reason = await checkStoredResolution(request, rec, ctx, fileMtimeMs);
    if (reason) ignored.push({ reason, ...meta });
    else winner = rec;
  }
  return { resolution: winner, ignored };
}

function buildStatus(
  request: ApprovalRequest,
  resolution: ApprovalResolution | undefined,
  use: ApprovalUse | undefined,
  ignored: IgnoredRecord[],
  now: number,
  fileMtimeMs?: number,
): ApprovalStatus {
  const trusted = resolution ? trustedResolutionTime(resolution, now, fileMtimeMs) : undefined;
  return {
    state: effectiveState(request, resolution, use),
    request,
    resolution,
    ...(use ? { use } : {}),
    ...(ignored.length ? { ignored } : {}),
    // An unreadable time stays unreadable ("invalid"): evaluateGrant then fails closed.
    ...(trusted
      ? {
          trustedResolvedAt: Number.isFinite(trusted.ms) ? new Date(trusted.ms).toISOString() : "invalid",
          ...(trusted.legacy ? { legacyTime: true } : {}),
        }
      : {}),
  };
}

/**
 * Stamp and judge a resolution about to be written. Throws a specific error for each way a
 * resolution can be refused. The stamp is the provider's own clock and overwrites any
 * `resolvedAtStore` the caller sent.
 */
async function prepareResolution(
  request: ApprovalRequest,
  res: ApprovalResolution,
  ctx: JudgeContext,
): Promise<ApprovalResolution> {
  validateResolution(res);
  await enforceSignature(request, res, ctx.policy);
  const stamped: ApprovalResolution = { ...res, resolvedAtStore: new Date(ctx.now).toISOString() };
  const reason = await checkStoredResolution(request, stamped, ctx);
  if (reason === "future_dated") {
    throw new Error(
      `approval resolution ${res.id} has a reviewedAt more than ${Math.round(ctx.skewMs / 1000)}s ahead of the store's clock — refusing`,
    );
  }
  if (reason === "before_request") {
    throw new Error(`approval resolution ${res.id} has a reviewedAt earlier than the ticket's requestedAt — refusing`);
  }
  if (reason) throw new Error(`approval resolution ${res.id} is not acceptable (${reason}) — refusing`);
  return stamped;
}

// -- In-memory provider (tests, ephemeral setups) ---------------------------

export class InMemoryApprovalProvider implements ApprovalProvider {
  private readonly requests: ApprovalRequest[] = [];
  private readonly resolutions = new Map<string, ApprovalResolution>();
  private readonly uses = new Map<string, ApprovalUse>();
  private readonly skewMs: number;

  constructor(private readonly signaturePolicy?: SignaturePolicy, options?: StoreOptions) {
    this.skewMs = options?.maxSkewMs ?? parseDuration(DEFAULT_REVIEW_SKEW);
  }

  async submit(req: ApprovalRequest): Promise<void> {
    assertGrantable(req);
    this.requests.push(req);
  }

  async check(id: string): Promise<ApprovalStatus | undefined> {
    return this.statusOf(id);
  }

  private statusOf(id: string): ApprovalStatus | undefined {
    const request = this.requests.find((r) => r.id === id);
    if (!request) return undefined;
    return buildStatus(request, this.resolutions.get(id), this.uses.get(id), [], Date.now());
  }

  async resolve(res: ApprovalResolution): Promise<ApprovalStatus> {
    validateResolution(res);
    const status = await this.check(res.id);
    assertResolvable(status, res.id);
    const stamped = await prepareResolution(status.request, res, {
      now: Date.now(),
      skewMs: this.skewMs,
      policy: this.signaturePolicy,
    });
    // Synchronous from the state check to the write: a second resolve cannot interleave.
    if (this.resolutions.has(res.id)) {
      throw new Error(`approval ticket ${res.id} is already resolved — terminal states are terminal`);
    }
    this.resolutions.set(res.id, stamped);
    return this.statusOf(res.id)!;
  }

  async consume(use: Omit<ApprovalUse, "token" | "usedAt">): Promise<boolean> {
    // Fully synchronous between the state check and the write: single-threaded JS makes the
    // claim atomic, so of N concurrent consumers exactly one sees "approved".
    const status = this.statusOf(use.id);
    if (!status || status.state !== "approved") return false;
    this.uses.set(use.id, { ...use, usedAt: new Date().toISOString(), token: randomUUID() });
    return true;
  }

  async list(filter?: { state?: ApprovalState }): Promise<ApprovalStatus[]> {
    const all = this.requests.map((r) => this.statusOf(r.id));
    const statuses = all.filter((s): s is ApprovalStatus => s !== undefined);
    return filter?.state ? statuses.filter((s) => s.state === filter.state) : statuses;
  }
}

// -- File provider (default: persisted, restart-safe) -----------------------

type LogRecord =
  | { kind: "request"; request: ApprovalRequest }
  | { kind: "resolution"; resolution: ApprovalResolution }
  | { kind: "use"; use: ApprovalUse };

/**
 * Append-only JSONL store under a directory (default `.kcp-harness/approvals`).
 * Every read replays the log, so a CLI in one process and the proxy in
 * another always see each other's writes — no daemon, no lock protocol
 * beyond O_APPEND line writes (approvals are low-volume by nature).
 *
 * The store is a TRUSTED-WRITER medium: anyone who can append to the file can append a record.
 * What the read path does about that is documented in docs/guide/governance.md ("Ticket store
 * trust model"): resolutions are judged on read (signature under require_signed_resolutions,
 * time sanity, first terminal resolution wins), but a store without required signatures still
 * accepts a well-formed forged `approved` record.
 */
export class FileApprovalProvider implements ApprovalProvider {
  private readonly file: string;
  private readonly skewMs: number;

  constructor(dir: string, private readonly signaturePolicy?: SignaturePolicy, options?: StoreOptions) {
    this.file = join(dir, "approvals.jsonl");
    this.skewMs = options?.maxSkewMs ?? parseDuration(DEFAULT_REVIEW_SKEW);
    mkdirSync(dir, { recursive: true });
  }

  /** The backing file path (for status displays). */
  getPath(): string {
    return this.file;
  }

  /** Raw replay of the log: no judgement, no signature work. */
  private readLog(): {
    requests: ApprovalRequest[];
    resolutions: Map<string, ApprovalResolution[]>;
    uses: Map<string, ApprovalUse>;
    mtimeMs?: number;
  } {
    const requests: ApprovalRequest[] = [];
    const seen = new Set<string>();
    const resolutions = new Map<string, ApprovalResolution[]>();
    const uses = new Map<string, ApprovalUse>();
    if (!existsSync(this.file)) return { requests, resolutions, uses };
    // An unreadable store throws here on purpose: the governor turns that into a block
    // (fail-closed). Only individually torn LINES are skipped below.
    const mtimeMs = statSync(this.file).mtimeMs;
    for (const line of readFileSync(this.file, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as LogRecord;
        if (record.kind === "request") {
          // First request for an id wins: a later line cannot replace a ticket's terms.
          if (record.request?.id && !seen.has(record.request.id)) {
            seen.add(record.request.id);
            requests.push(record.request);
          }
        } else if (record.kind === "resolution" && record.resolution?.id) {
          const list = resolutions.get(record.resolution.id) ?? [];
          list.push(record.resolution);
          resolutions.set(record.resolution.id, list);
        }
        // First claim in log order wins; O_APPEND line writes are atomic across processes.
        else if (record.kind === "use" && !uses.has(record.use.id)) uses.set(record.use.id, record.use);
      } catch {
        // A torn write must not take the whole store down — skip the line.
        // Fail-closed still holds: a missing resolution reads as pending/expired.
      }
    }
    return { requests, resolutions, uses, mtimeMs };
  }

  private ctx(): JudgeContext {
    return { now: Date.now(), skewMs: this.skewMs, policy: this.signaturePolicy };
  }

  /** Replay + judge: the effective status of every ticket. */
  private async readAll(): Promise<ApprovalStatus[]> {
    const { requests, resolutions, uses, mtimeMs } = this.readLog();
    const ctx = this.ctx();
    const out: ApprovalStatus[] = [];
    for (const request of requests) {
      const { resolution, ignored } = await foldResolutions(request, resolutions.get(request.id) ?? [], ctx, mtimeMs);
      out.push(buildStatus(request, resolution, uses.get(request.id), ignored, ctx.now, mtimeMs));
    }
    return out;
  }

  private append(record: LogRecord): void {
    appendFileSync(this.file, JSON.stringify(record) + "\n", "utf-8");
  }

  async submit(req: ApprovalRequest): Promise<void> {
    assertGrantable(req);
    this.append({ kind: "request", request: req });
  }

  async check(id: string): Promise<ApprovalStatus | undefined> {
    return (await this.readAll()).find((s) => s.request.id === id);
  }

  async resolve(res: ApprovalResolution): Promise<ApprovalStatus> {
    validateResolution(res);
    const status = await this.check(res.id);
    assertResolvable(status, res.id);
    const stamped = await prepareResolution(status.request, res, this.ctx());
    this.append({ kind: "resolution", resolution: stamped });
    // Two reviewers racing: the first valid record in log order wins on every read. If it is
    // not ours, we lost — say so instead of reporting a resolution that does not hold.
    const after = await this.check(res.id);
    if (!after?.resolution || JSON.stringify(after.resolution) !== JSON.stringify(stamped)) {
      throw new Error(`approval ticket ${res.id} was resolved first by another record — terminal states are terminal`);
    }
    return after;
  }

  /**
   * Claim by appending a uniquely-tokened use record, then re-reading: the first use record
   * for the ticket in log order wins. Safe across processes without a lock.
   */
  async consume(use: Omit<ApprovalUse, "token" | "usedAt">): Promise<boolean> {
    const before = await this.check(use.id);
    if (!before || before.state !== "approved") return false;
    const token = randomUUID();
    this.append({ kind: "use", use: { ...use, usedAt: new Date().toISOString(), token } });
    return this.readLog().uses.get(use.id)?.token === token;
  }

  async list(filter?: { state?: ApprovalState }): Promise<ApprovalStatus[]> {
    const statuses = await this.readAll();
    return filter?.state ? statuses.filter((s) => s.state === filter.state) : statuses;
  }
}

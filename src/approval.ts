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
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
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
  reviewedAt: string;
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

/** Construct the configured ticket store. */
export function providerFromConfig(config: ApprovalsConfig): ApprovalProvider {
  const sig: SignaturePolicy = {
    requireSigned: config.require_signed_resolutions === true,
    trustedKeys: config.trusted_keys,
  };
  if (config.provider === "memory") return new InMemoryApprovalProvider(sig);
  return new FileApprovalProvider(config.dir ?? DEFAULT_APPROVALS_DIR, sig);
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
  return {
    id: randomUUID(),
    requestedAt: new Date().toISOString(),
    ...fields,
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
  now?: number;
}

/**
 * Is an approved ticket a valid grant for this call? Pure and fail-closed: anything that
 * cannot be positively evaluated (missing/garbled dates, missing session ids, unknown grant
 * mode) is a denial with reason "invalid", never an approval.
 *
 * Legacy tickets (approved before grants existed — no `request.grant`) are treated as
 * `session` scoped by `request.sessionId` and expire at `resolvedAt + grant_max`.
 */
export function evaluateGrant(
  status: ApprovalStatus,
  q: GrantQuery,
): { ok: true } | { ok: false; reason: GrantDenyReason } {
  try {
    if (status.state === "used") return { ok: false, reason: "used" };
    if (status.state !== "approved" || !status.resolution) return { ok: false, reason: "invalid" };
    if (!q.sessionId || !status.request.sessionId) return { ok: false, reason: "invalid" };
    if (!Number.isFinite(q.maxMs) || q.maxMs <= 0) return { ok: false, reason: "invalid" };

    const resolvedAt = Date.parse(status.resolution.reviewedAt);
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
    if (status.request.argsDigest && status.request.argsDigest !== q.argsDigest) {
      return { ok: false, reason: "args_mismatch" };
    }
    if ((q.now ?? Date.now()) >= resolvedAt + windowMs) return { ok: false, reason: "expired" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** Outcome of looking for a grant that covers a call. */
export type GrantOutcome =
  /** A valid grant covers the call (a `once` grant has been consumed by it). */
  | { kind: "granted"; status: ApprovalStatus }
  /** A ticket for this session is awaiting a human. */
  | { kind: "pending"; status: ApprovalStatus }
  /** This session's newest ticket was dismissed — terminal. */
  | { kind: "dismissed"; status: ApprovalStatus }
  /** No usable ticket: the caller should open a new one. `denied` says why an approval was refused. */
  | { kind: "open"; previous?: ApprovalStatus; denied?: { reason: GrantDenyReason; ticketId?: string } }
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
 */
export async function resolveGrant(provider: ApprovalProvider, q: GrantQuery): Promise<GrantOutcome> {
  if (!q.sessionId) return { kind: "invalid", denied: { reason: "invalid" } };
  const all = await provider.list();
  const candidates = all.filter(
    (s) =>
      s.request.target === q.target &&
      s.request.toolName === q.toolName &&
      // A ticket bound to a digest only matches a call with that digest. Legacy / unbound
      // tickets (no digest) match any arguments — a documented limit of migrated tickets.
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

  if (newest.state === "pending_review") return { kind: "pending", status: newest };
  if (newest.state === "dismissed" && newest.resolution) return { kind: "dismissed", status: newest };
  if (newest.state === "expired") return { kind: "open", previous: newest };

  // approved | used (anything else is not understood → fail closed)
  const verdict = evaluateGrant(newest, q);
  if (!verdict.ok) {
    return { kind: "open", previous: newest, denied: { reason: verdict.reason, ticketId: newest.request.id } };
  }
  if ((newest.request.grant?.mode ?? "session") === "once") {
    if (!provider.consume) {
      return { kind: "open", previous: newest, denied: { reason: "invalid", ticketId: newest.request.id } };
    }
    const won = await provider.consume({
      id: newest.request.id,
      sessionId: q.sessionId,
      ...(q.correlationId ? { correlationId: q.correlationId } : {}),
    });
    if (!won) {
      return { kind: "open", previous: newest, denied: { reason: "used", ticketId: newest.request.id } };
    }
  }
  return { kind: "granted", status: newest };
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

/**
 * Enforce the signature policy at resolution time. Fail-closed: when the org
 * requires signed resolutions, a missing or invalid signature is not a valid
 * resolution and the resolve throws. When the flag is off, behavior is
 * unchanged — a signature, if present, is stored verbatim but not required.
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
  const ok = await verifyResolutionSignature(
    {
      id: res.id,
      target: request.target,
      tool: request.toolName,
      state: res.state,
      reviewer: res.reviewer,
      policyRef: res.policyRef,
      timestamp: res.reviewedAt,
    },
    res.signature,
    policy.trustedKeys,
  );
  if (!ok) {
    throw new Error(
      `approval resolution ${res.id} has an invalid signature — fail-closed, not resolving`,
    );
  }
}

/** The canonical payload a reviewer signs for a given ticket + resolution. */
export function resolutionPayload(request: ApprovalRequest, res: ApprovalResolution): string {
  return canonicalResolutionPayload({
    id: res.id,
    target: request.target,
    tool: request.toolName,
    state: res.state,
    reviewer: res.reviewer,
    policyRef: res.policyRef,
    timestamp: res.reviewedAt,
  });
}

/** Check a ticket is resolvable; throws with the reason if not. */
function assertResolvable(status: ApprovalStatus | undefined, id: string): asserts status is ApprovalStatus {
  if (!status) throw new Error(`unknown approval ticket: ${id}`);
  if (status.state === "expired") throw new Error(`approval ticket ${id} has expired`);
  if (status.state !== "pending_review") {
    throw new Error(`approval ticket ${id} is already resolved (${status.state}) — terminal states are terminal`);
  }
}

// -- In-memory provider (tests, ephemeral setups) ---------------------------

export class InMemoryApprovalProvider implements ApprovalProvider {
  private readonly requests: ApprovalRequest[] = [];
  private readonly resolutions = new Map<string, ApprovalResolution>();
  private readonly uses = new Map<string, ApprovalUse>();

  constructor(private readonly signaturePolicy?: SignaturePolicy) {}

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
    const resolution = this.resolutions.get(id);
    const use = this.uses.get(id);
    return { state: effectiveState(request, resolution, use), request, resolution, ...(use ? { use } : {}) };
  }

  async resolve(res: ApprovalResolution): Promise<ApprovalStatus> {
    validateResolution(res);
    const status = await this.check(res.id);
    assertResolvable(status, res.id);
    await enforceSignature(status.request, res, this.signaturePolicy);
    this.resolutions.set(res.id, res);
    return { state: res.state, request: status.request, resolution: res };
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
 */
export class FileApprovalProvider implements ApprovalProvider {
  private readonly file: string;

  constructor(dir: string, private readonly signaturePolicy?: SignaturePolicy) {
    this.file = join(dir, "approvals.jsonl");
    mkdirSync(dir, { recursive: true });
  }

  /** The backing file path (for status displays). */
  getPath(): string {
    return this.file;
  }

  private read(): {
    requests: ApprovalRequest[];
    resolutions: Map<string, ApprovalResolution>;
    uses: Map<string, ApprovalUse>;
  } {
    const requests: ApprovalRequest[] = [];
    const resolutions = new Map<string, ApprovalResolution>();
    const uses = new Map<string, ApprovalUse>();
    if (!existsSync(this.file)) return { requests, resolutions, uses };
    // An unreadable store throws here on purpose: the governor turns that into a block
    // (fail-closed). Only individually torn LINES are skipped below.
    for (const line of readFileSync(this.file, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as LogRecord;
        if (record.kind === "request") requests.push(record.request);
        else if (record.kind === "resolution") resolutions.set(record.resolution.id, record.resolution);
        // First claim in log order wins; O_APPEND line writes are atomic across processes.
        else if (record.kind === "use" && !uses.has(record.use.id)) uses.set(record.use.id, record.use);
      } catch {
        // A torn write must not take the whole store down — skip the line.
        // Fail-closed still holds: a missing resolution reads as pending/expired.
      }
    }
    return { requests, resolutions, uses };
  }

  private append(record: LogRecord): void {
    appendFileSync(this.file, JSON.stringify(record) + "\n", "utf-8");
  }

  async submit(req: ApprovalRequest): Promise<void> {
    assertGrantable(req);
    this.append({ kind: "request", request: req });
  }

  async check(id: string): Promise<ApprovalStatus | undefined> {
    const { requests, resolutions, uses } = this.read();
    const request = requests.find((r) => r.id === id);
    if (!request) return undefined;
    return this.build(request, resolutions, uses);
  }

  private build(
    request: ApprovalRequest,
    resolutions: Map<string, ApprovalResolution>,
    uses: Map<string, ApprovalUse>,
  ): ApprovalStatus {
    const resolution = resolutions.get(request.id);
    const use = uses.get(request.id);
    return { state: effectiveState(request, resolution, use), request, resolution, ...(use ? { use } : {}) };
  }

  async resolve(res: ApprovalResolution): Promise<ApprovalStatus> {
    validateResolution(res);
    const status = await this.check(res.id);
    assertResolvable(status, res.id);
    await enforceSignature(status.request, res, this.signaturePolicy);
    this.append({ kind: "resolution", resolution: res });
    return { state: res.state, request: status.request, resolution: res };
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
    return this.read().uses.get(use.id)?.token === token;
  }

  async list(filter?: { state?: ApprovalState }): Promise<ApprovalStatus[]> {
    const { requests, resolutions, uses } = this.read();
    const statuses = requests.map((request) => this.build(request, resolutions, uses));
    return filter?.state ? statuses.filter((s) => s.state === filter.state) : statuses;
  }
}

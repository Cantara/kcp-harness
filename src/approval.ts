// Approval — pending governance decisions resolved by a named human.
//
// Some governed actions must not be decided by the automated gate cascade
// alone: org policy demands a named human sign off, and that can take
// minutes or days. This module is the state machine for those decisions:
//
//   pending_review ─▶ approved   (terminal, by a named reviewer)
//          │────────▶ dismissed  (terminal, by a named reviewer)
//          └────────▶ expired    (terminal, via TTL — fail-closed)
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

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_APPROVALS_DIR, type ApprovalsConfig } from "./config.js";

/** Lifecycle states for an approval ticket. */
export type ApprovalState = "pending_review" | "approved" | "dismissed" | "expired";

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
  /** ISO timestamp after which an unresolved ticket reads as expired. */
  expiresAt?: string;
  /** Evidence generated at request time — why a human is being asked. */
  evidence: {
    manifest?: string;
    /** The policy rule that demanded human sign-off. */
    policyRef?: string;
    detail?: string;
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
}

/** Current status of a ticket: its request, computed state, and resolution. */
export interface ApprovalStatus {
  state: ApprovalState;
  request: ApprovalRequest;
  resolution?: ApprovalResolution;
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
}

/** Construct the configured ticket store. */
export function providerFromConfig(config: ApprovalsConfig): ApprovalProvider {
  if (config.provider === "memory") return new InMemoryApprovalProvider();
  return new FileApprovalProvider(config.dir ?? DEFAULT_APPROVALS_DIR);
}

/** Build a new ticket with id + requestedAt assigned. */
export function newRequest(
  fields: Omit<ApprovalRequest, "id" | "requestedAt"> & { expiresAt?: string },
): ApprovalRequest {
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
 * Find the most recent ticket for a (target, tool) pair, whatever its state.
 * The governor uses this to decide whether to honor, wait on, or re-submit.
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

// -- Shared state-machine core ----------------------------------------------

/** Compute the effective state, applying TTL expiry to unresolved tickets. */
function effectiveState(request: ApprovalRequest, resolution?: ApprovalResolution): ApprovalState {
  if (resolution) return resolution.state;
  if (request.expiresAt && Date.parse(request.expiresAt) < Date.now()) return "expired";
  return "pending_review";
}

function validateResolution(res: ApprovalResolution): void {
  if (!res.reviewer?.trim()) throw new Error("approval resolution requires a named reviewer");
  if (!res.policyRef?.trim()) {
    throw new Error("approval resolution requires a policyRef — approved alone is not evidence");
  }
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

  async submit(req: ApprovalRequest): Promise<void> {
    this.requests.push(req);
  }

  async check(id: string): Promise<ApprovalStatus | undefined> {
    const request = this.requests.find((r) => r.id === id);
    if (!request) return undefined;
    const resolution = this.resolutions.get(id);
    return { state: effectiveState(request, resolution), request, resolution };
  }

  async resolve(res: ApprovalResolution): Promise<ApprovalStatus> {
    validateResolution(res);
    const status = await this.check(res.id);
    assertResolvable(status, res.id);
    this.resolutions.set(res.id, res);
    return { state: res.state, request: status.request, resolution: res };
  }

  async list(filter?: { state?: ApprovalState }): Promise<ApprovalStatus[]> {
    const all = await Promise.all(this.requests.map((r) => this.check(r.id)));
    const statuses = all.filter((s): s is ApprovalStatus => s !== undefined);
    return filter?.state ? statuses.filter((s) => s.state === filter.state) : statuses;
  }
}

// -- File provider (default: persisted, restart-safe) -----------------------

type LogRecord =
  | { kind: "request"; request: ApprovalRequest }
  | { kind: "resolution"; resolution: ApprovalResolution };

/**
 * Append-only JSONL store under a directory (default `.kcp-harness/approvals`).
 * Every read replays the log, so a CLI in one process and the proxy in
 * another always see each other's writes — no daemon, no lock protocol
 * beyond O_APPEND line writes (approvals are low-volume by nature).
 */
export class FileApprovalProvider implements ApprovalProvider {
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, "approvals.jsonl");
    mkdirSync(dir, { recursive: true });
  }

  /** The backing file path (for status displays). */
  getPath(): string {
    return this.file;
  }

  private read(): { requests: ApprovalRequest[]; resolutions: Map<string, ApprovalResolution> } {
    const requests: ApprovalRequest[] = [];
    const resolutions = new Map<string, ApprovalResolution>();
    if (!existsSync(this.file)) return { requests, resolutions };
    for (const line of readFileSync(this.file, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as LogRecord;
        if (record.kind === "request") requests.push(record.request);
        else if (record.kind === "resolution") resolutions.set(record.resolution.id, record.resolution);
      } catch {
        // A torn write must not take the whole store down — skip the line.
        // Fail-closed still holds: a missing resolution reads as pending/expired.
      }
    }
    return { requests, resolutions };
  }

  private append(record: LogRecord): void {
    appendFileSync(this.file, JSON.stringify(record) + "\n", "utf-8");
  }

  async submit(req: ApprovalRequest): Promise<void> {
    this.append({ kind: "request", request: req });
  }

  async check(id: string): Promise<ApprovalStatus | undefined> {
    const { requests, resolutions } = this.read();
    const request = requests.find((r) => r.id === id);
    if (!request) return undefined;
    const resolution = resolutions.get(id);
    return { state: effectiveState(request, resolution), request, resolution };
  }

  async resolve(res: ApprovalResolution): Promise<ApprovalStatus> {
    validateResolution(res);
    const status = await this.check(res.id);
    assertResolvable(status, res.id);
    this.append({ kind: "resolution", resolution: res });
    return { state: res.state, request: status.request, resolution: res };
  }

  async list(filter?: { state?: ApprovalState }): Promise<ApprovalStatus[]> {
    const { requests, resolutions } = this.read();
    const statuses = requests.map((request) => ({
      state: effectiveState(request, resolutions.get(request.id)),
      request,
      resolution: resolutions.get(request.id),
    }));
    return filter?.state ? statuses.filter((s) => s.state === filter.state) : statuses;
  }
}

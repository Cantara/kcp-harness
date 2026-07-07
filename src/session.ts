// Session state — tracks approved plans, known units, and budget across calls.
//
// The session is the harness's ephemeral governance state. It lives for one
// agent session (process lifetime) and is never persisted. All durable state
// goes to the audit log.
//
// Key responsibilities:
// 1. Track which plans the agent has established (approved unit sets)
// 2. Track known[] for session dedup (units already loaded)
// 3. Track cumulative budget spend
// 4. Assign monotonic sequence numbers for audit correlation

import { randomUUID } from "node:crypto";
import type { AgentPlan, PlannedUnit, FollowOptions } from "kcp-agent";
import { BudgetLedger, type BudgetCeiling } from "./budget-ledger.js";
import { TemporalWatch } from "./temporal-watch.js";

/** An approved plan — the set of units the agent is allowed to access. */
export interface ApprovedPlan {
  /** The manifest this plan came from. */
  manifest: string;
  /** The task the plan was created for. */
  task: string;
  /** The full plan from kcp-agent. */
  plan: AgentPlan;
  /** Timestamp when the plan was approved. */
  approvedAt: string;
}

/** Session state for one agent connection. */
export interface SessionState {
  /** Unique session identifier. */
  id: string;
  /** Approved plans indexed by manifest source. */
  plans: Map<string, ApprovedPlan>;
  /** Units the session has loaded (id → sha256) for dedup. */
  known: Map<string, string>;
  /** Cumulative money budget spent this session. */
  budgetSpent: number;
  /** Monotonic sequence counter for audit events. */
  sequence: number;
  /** Session start time (ISO 8601). */
  startedAt: string;
  /** Budget ledger — itemized spend tracking. */
  ledger: BudgetLedger;
  /** Temporal watcher — detects plan drift. */
  temporalWatch: TemporalWatch;
}

/** Create a fresh session state. */
export function createSession(budgetCeiling?: BudgetCeiling): SessionState {
  return {
    id: randomUUID(),
    plans: new Map(),
    known: new Map(),
    budgetSpent: 0,
    sequence: 0,
    startedAt: new Date().toISOString(),
    ledger: new BudgetLedger(budgetCeiling),
    temporalWatch: new TemporalWatch(),
  };
}

/** Register an approved plan in the session. */
export function addPlan(session: SessionState, manifest: string, task: string, plan: AgentPlan): void {
  session.plans.set(manifest, { manifest, task, plan, approvedAt: new Date().toISOString() });
}

/** Check if a file path is in any approved plan's selected units. */
export function isPathApproved(session: SessionState, path: string): ApprovedPlan | undefined {
  for (const approved of session.plans.values()) {
    for (const unit of approved.plan.selected) {
      if (unit.loadEligible && pathMatchesUnit(path, unit, approved.manifest)) {
        return approved;
      }
    }
  }
  return undefined;
}

/** Check if a unit path matches a target file path (relative resolution). */
function pathMatchesUnit(targetPath: string, unit: PlannedUnit, manifestSource: string): boolean {
  const unitPath = unit.path;

  // Direct match
  if (targetPath === unitPath) return true;
  if (targetPath.endsWith("/" + unitPath)) return true;
  if (targetPath.endsWith(unitPath)) return true;

  // Resolve relative to manifest directory
  if (manifestSource) {
    const manifestDir = manifestSource.replace(/\/[^/]*$/, "");
    const resolved = manifestDir + "/" + unitPath;
    if (targetPath === resolved) return true;
    if (normalizePath(targetPath) === normalizePath(resolved)) return true;
  }

  return false;
}

function normalizePath(p: string): string {
  return p.replace(/\/+/g, "/").replace(/^\.\//, "");
}

/** Record a loaded unit's sha256 for session dedup. */
export function recordLoaded(session: SessionState, id: string, sha256: string): void {
  session.known.set(id, sha256);
}

/** Get the known[] set for passing to kcp_load. */
export function getKnown(session: SessionState): Array<{ id: string; sha256: string }> {
  return Array.from(session.known.entries()).map(([id, sha256]) => ({ id, sha256 }));
}

/** Record budget expenditure. */
export function recordSpend(session: SessionState, amount: number): void {
  session.budgetSpent += amount;
}

/** Get next sequence number (auto-increments). */
export function nextSequence(session: SessionState): number {
  return ++session.sequence;
}

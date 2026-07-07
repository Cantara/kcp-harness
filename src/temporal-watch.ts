// Temporal watch — detect plan drift when time changes governance outcomes.
//
// The temporal watcher periodically re-evaluates approved plans against their
// manifests to detect when temporal gates (valid_from, valid_until, supersession)
// would produce a different plan than the one currently approved. When drift is
// detected, it emits a plan diff and optionally invalidates the stale plan.
//
// This is the "temporal governance" layer: it ensures that approved plans don't
// outlive their temporal validity. A plan approved at 09:00 might become stale
// at midnight when a superseding unit activates.
//
// Usage:
// 1. Register plans with the watcher (automatic via governor)
// 2. Call `check()` to evaluate all plans against current time
// 3. Drifted plans emit audit events and are optionally invalidated
//
// The watcher is pure: it re-runs the kcp-agent planner with the current
// date and diffs against the stored plan. No mutation unless `invalidate` is set.

import {
  planTree,
  plans,
  diffPlans,
  type AgentPlan,
  type PlanDiff,
  type FollowOptions,
  type PlanOptions,
} from "kcp-agent";

/** A plan registered for temporal watching. */
export interface WatchedPlan {
  /** The manifest source. */
  manifest: string;
  /** The task the plan was created for. */
  task: string;
  /** The approved plan. */
  plan: AgentPlan;
  /** FollowOptions used to create the plan (for re-evaluation). */
  followOptions: FollowOptions;
  /** When the plan was registered. */
  registeredAt: string;
  /** Last time this plan was checked. */
  lastChecked?: string;
}

/** Result of checking a single plan for temporal drift. */
export interface DriftResult {
  /** The manifest that was checked. */
  manifest: string;
  /** The task. */
  task: string;
  /** Whether the plan has drifted. */
  drifted: boolean;
  /** The diff (if drifted). */
  diff?: PlanDiff;
  /** The new plan (if drifted). */
  newPlan?: AgentPlan;
  /** Human-readable summary. */
  summary: string;
  /** Timestamp of the check. */
  checkedAt: string;
}

/** Result of checking all watched plans. */
export interface WatchResult {
  /** Total plans checked. */
  checked: number;
  /** Plans that have drifted. */
  drifted: DriftResult[];
  /** Plans that are still valid. */
  stable: number;
  /** Plans that couldn't be re-evaluated (manifest unavailable, etc.). */
  errors: Array<{ manifest: string; error: string }>;
}

/** Temporal plan watcher. */
export class TemporalWatch {
  private watched = new Map<string, WatchedPlan>();

  /** Register a plan for temporal watching. */
  register(
    manifest: string,
    task: string,
    plan: AgentPlan,
    followOptions: FollowOptions,
  ): void {
    this.watched.set(manifest, {
      manifest,
      task,
      plan,
      followOptions,
      registeredAt: new Date().toISOString(),
    });
  }

  /** Remove a plan from watching (e.g., after invalidation). */
  unregister(manifest: string): void {
    this.watched.delete(manifest);
  }

  /** Check all watched plans for temporal drift. */
  async check(): Promise<WatchResult> {
    const drifted: DriftResult[] = [];
    const errors: Array<{ manifest: string; error: string }> = [];
    let stable = 0;

    for (const [manifest, watched] of this.watched) {
      try {
        const result = await this.checkOne(watched);
        watched.lastChecked = result.checkedAt;

        if (result.drifted) {
          drifted.push(result);
        } else {
          stable++;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ manifest, error: msg });
      }
    }

    return { checked: this.watched.size, drifted, stable, errors };
  }

  /** Check a single plan for temporal drift. */
  async checkOne(watched: WatchedPlan): Promise<DriftResult> {
    const now = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Re-plan with current date
    const freshOptions: FollowOptions = {
      ...watched.followOptions,
      planOptions: {
        ...watched.followOptions.planOptions,
        asOf: now, // Force current date
      },
    };

    const tree = await planTree(watched.manifest, watched.task, freshOptions);
    if (tree.error) {
      throw new Error(`manifest error: ${tree.error}`);
    }

    const freshPlans = Array.from(plans(tree));
    const freshPlan = freshPlans[0];
    if (!freshPlan) {
      throw new Error("re-plan returned no plan");
    }

    // Diff against the stored plan
    const diff = diffPlans(watched.plan, freshPlan);
    const checkedAt = new Date().toISOString();

    if (diff.identical) {
      return {
        manifest: watched.manifest,
        task: watched.task,
        drifted: false,
        summary: `plan is stable (checked at ${now})`,
        checkedAt,
      };
    }

    // Build a human-readable summary of what changed
    const summary = summarizeDrift(diff);

    return {
      manifest: watched.manifest,
      task: watched.task,
      drifted: true,
      diff,
      newPlan: freshPlan,
      summary,
      checkedAt,
    };
  }

  /** Get all watched plans. */
  getWatched(): ReadonlyMap<string, WatchedPlan> {
    return this.watched;
  }

  /** Get a watched plan by manifest. */
  get(manifest: string): WatchedPlan | undefined {
    return this.watched.get(manifest);
  }
}

/** Build a human-readable summary of plan drift. */
function summarizeDrift(diff: PlanDiff): string {
  const parts: string[] = [];

  if (diff.moves.length > 0) {
    const sel2skip = diff.moves.filter((m) => m.direction === "selected_to_skipped");
    const skip2sel = diff.moves.filter((m) => m.direction === "skipped_to_selected");
    if (sel2skip.length > 0) {
      parts.push(`${sel2skip.length} unit(s) dropped: ${sel2skip.map((m) => m.id).join(", ")}`);
    }
    if (skip2sel.length > 0) {
      parts.push(`${skip2sel.length} unit(s) activated: ${skip2sel.map((m) => m.id).join(", ")}`);
    }
  }

  if (diff.scoreChanges.length > 0) {
    parts.push(`${diff.scoreChanges.length} score change(s)`);
  }

  if (diff.presence.length > 0) {
    const added = diff.presence.filter((p) => p.side === "b_only");
    const removed = diff.presence.filter((p) => p.side === "a_only");
    if (added.length > 0) parts.push(`${added.length} new unit(s)`);
    if (removed.length > 0) parts.push(`${removed.length} removed unit(s)`);
  }

  if (diff.reasonChanges.length > 0) {
    parts.push(`${diff.reasonChanges.length} reason change(s)`);
  }

  if (diff.budgetShifts.length > 0) {
    parts.push(`${diff.budgetShifts.length} budget shift(s)`);
  }

  const temporal = diff.a.asOf !== diff.b.asOf
    ? ` (${diff.a.asOf} → ${diff.b.asOf})`
    : "";

  return `temporal drift detected${temporal}: ${parts.join("; ") || "structural change"}`;
}

// Governor — enforce governance via kcp-agent's deterministic planner.
//
// The governor is the enforcement layer. When the classifier identifies a
// tool call as knowledge-navigation, the governor decides whether to allow
// it by running the kcp-agent planner and checking the result.
//
// Two modes:
//
// 1. **Plan-first** (preferred): the agent has called kcp_plan/kcp_load and
//    established an approved plan. Subsequent tool calls are checked against
//    the plan's selected units. Fast — no planner call needed.
//
// 2. **Auto-plan** (fallback): the agent tries to access a governed path
//    without a prior plan. The governor auto-creates a plan with the file
//    path as the task, then checks eligibility. If the path's unit is
//    selected → approve; if not → block.
//
// In both modes, the governor is fail-closed: if the planner can't reach
// the manifest, if the unit isn't selected, or if the budget is exhausted,
// the call is blocked — never silently passed through.

import {
  planTree,
  plans,
  loadPlannedUnits,
  loadManifest,
  trace as traceDecision,
  type AgentPlan,
  type DecisionTrace,
  type PlanOptions,
  type FollowOptions,
} from "kcp-agent";
import type { GovernancePolicy, GovernedDomain } from "./config.js";
import type { Classification } from "./classifier.js";
import type { SessionState, ApprovedPlan } from "./session.js";
import { isPathApproved, addPlan, recordSpend } from "./session.js";
import type { SpendResult } from "./budget-ledger.js";

/** The governor's decision for a tool call. */
export interface GovernanceDecision {
  /** Whether the tool call is approved. */
  approved: boolean;
  /** How the decision was made. */
  mode: "plan-first" | "auto-plan" | "kcp-passthrough" | "blocked";
  /** The plan that governs this decision (if any). */
  plan?: AgentPlan;
  /** The decision trace (if tracing is enabled). */
  trace?: DecisionTrace;
  /** Human-readable reason for the decision. */
  reason: string;
  /** The approved plan that matched (for plan-first mode). */
  approvedPlan?: ApprovedPlan;
  /** Budget spend result (for auto-plan mode with costs). */
  budgetSpend?: SpendResult;
}

/**
 * Govern a classified tool call — decide whether to approve or block.
 *
 * For KCP tools (kcp_plan, kcp_load, etc.), the call is always passed through
 * to the kcp-agent planner directly — the harness doesn't gate KCP's own tools.
 *
 * For file/URL tools targeting governed domains, the governor checks:
 * 1. Is there an existing approved plan that covers this path? → approve
 * 2. If not, auto-plan against the domain's manifest → approve if selected
 * 3. Otherwise → block (fail-closed)
 */
export async function govern(
  classification: Classification,
  toolName: string,
  args: Record<string, unknown>,
  session: SessionState,
  policy: GovernancePolicy,
): Promise<GovernanceDecision> {
  // KCP tools pass through — they ARE the governance layer
  if (toolName.startsWith("kcp_")) {
    return { approved: true, mode: "kcp-passthrough", reason: "KCP tool — governance layer itself" };
  }

  if (!classification.governed || !classification.domain) {
    return { approved: true, mode: "kcp-passthrough", reason: "ungoverned tool call" };
  }

  const domain = classification.domain;
  const target = classification.target;

  // Mode 1: check existing approved plans
  if (target) {
    const approved = isPathApproved(session, target);
    if (approved) {
      return {
        approved: true,
        mode: "plan-first",
        plan: approved.plan,
        approvedPlan: approved,
        reason: `path ${target} is in approved plan for "${approved.task}"`,
      };
    }
  }

  // Mode 2: auto-plan — create a governance plan on the fly
  if (target && domain.manifest) {
    try {
      const autoPlan = await autoGovern(target, domain, session, policy);
      return autoPlan;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Fail-closed: planner error → block
      if (policy.fail_closed) {
        return {
          approved: false,
          mode: "blocked",
          reason: `auto-plan failed (fail-closed): ${msg}`,
        };
      }
      return {
        approved: false,
        mode: "blocked",
        reason: `auto-plan failed: ${msg}`,
      };
    }
  }

  // No target extractable + governed domain → block
  return {
    approved: false,
    mode: "blocked",
    reason: `governed tool call with no extractable target — blocked by policy`,
  };
}

/**
 * Auto-govern: run the kcp-agent planner to decide if accessing a target
 * path is approved. Creates a plan and checks if the target is in the
 * selected set.
 */
async function autoGovern(
  target: string,
  domain: GovernedDomain,
  session: SessionState,
  policy: GovernancePolicy,
): Promise<GovernanceDecision> {
  const followOptions = buildFollowOptions(policy, session);

  // Use the target path as the task — the planner will score units
  // against this and select the most relevant ones.
  const task = `access ${target}`;
  const tree = await planTree(domain.manifest, task, followOptions);

  if (tree.error) {
    return {
      approved: false,
      mode: "blocked",
      reason: `manifest error: ${tree.error}`,
    };
  }

  // Extract the flat plan list
  const allPlans = Array.from(plans(tree));
  const rootPlan = allPlans[0];

  if (!rootPlan) {
    return {
      approved: false,
      mode: "blocked",
      reason: "planner returned no plan",
    };
  }

  // Check: is the target path in the selected set?
  const targetNorm = normalizePath(target);
  const matchingUnit = rootPlan.selected.find(
    (u) => u.loadEligible && pathOverlaps(targetNorm, u.path),
  );

  if (matchingUnit) {
    // Register the plan in the session for future fast-path lookups
    addPlan(session, domain.manifest, task, rootPlan);

    // Track budget spend via ledger
    let budgetSpend: SpendResult | undefined;
    if (rootPlan.budget?.projectedSpend) {
      const currency = rootPlan.budget.currency ?? "USDC";
      budgetSpend = session.ledger.recordPlanSpend(
        domain.manifest, task, rootPlan.budget.projectedSpend, currency,
      );
      // Also update the legacy counter
      recordSpend(session, rootPlan.budget.projectedSpend);

      if (!budgetSpend.accepted) {
        return {
          approved: false,
          mode: "auto-plan",
          plan: rootPlan,
          budgetSpend,
          reason: `auto-plan blocked: budget ceiling exceeded — ${budgetSpend.reason}`,
        };
      }
    }

    // Register with temporal watcher
    session.temporalWatch.register(domain.manifest, task, rootPlan, followOptions);

    return {
      approved: true,
      mode: "auto-plan",
      plan: rootPlan,
      budgetSpend,
      reason: `auto-plan approved: unit "${matchingUnit.id}" (score ${matchingUnit.score}) covers ${target}`,
    };
  }

  // Check: was the unit selected but not load-eligible? (paywall, attestation, etc.)
  const ineligibleUnit = rootPlan.selected.find(
    (u) => !u.loadEligible && pathOverlaps(targetNorm, u.path),
  );

  if (ineligibleUnit) {
    return {
      approved: false,
      mode: "auto-plan",
      plan: rootPlan,
      reason: `auto-plan blocked: unit "${ineligibleUnit.id}" covers ${target} but is not load-eligible (${ineligibleUnit.reasons.filter(r => r.startsWith("unaffordable") || r.startsWith("needs")).join("; ") || "gate restriction"})`,
    };
  }

  // Target not in selected set → check if it was skipped and why
  const skippedUnit = rootPlan.skipped.find(
    (u) => pathOverlaps(targetNorm, u.id),
  );

  const skipReason = skippedUnit
    ? `unit "${skippedUnit.id}" was skipped: ${skippedUnit.reason}`
    : `no unit covers path ${target}`;

  return {
    approved: false,
    mode: "auto-plan",
    plan: rootPlan,
    reason: `auto-plan blocked: ${skipReason}`,
  };
}

/** Build FollowOptions from governance policy and session state. */
function buildFollowOptions(policy: GovernancePolicy, session: SessionState): FollowOptions {
  const planOptions: PlanOptions = {
    maxUnits: policy.max_units,
    strict: policy.strict,
    env: policy.env,
  };

  if (policy.budget) {
    planOptions.budget = {
      amount: policy.budget.amount,
      currency: policy.budget.currency,
      spent: session.budgetSpent,
    };
  }

  if (policy.context_budget !== undefined) {
    planOptions.contextBudget = policy.context_budget;
  }

  return {
    planOptions,
    maxDepth: 0,       // auto-plan doesn't follow federation by default
    fetchGuard: {},    // default guards (no private hosts, https only)
  };
}

function normalizePath(p: string): string {
  return p.replace(/\/+/g, "/").replace(/^\.\//, "");
}

/** Check if a target path overlaps with a unit path (loose match). */
function pathOverlaps(target: string, unitPath: string): boolean {
  const a = normalizePath(target);
  const b = normalizePath(unitPath);
  return a === b || a.endsWith("/" + b) || a.endsWith(b) || b.endsWith("/" + a);
}

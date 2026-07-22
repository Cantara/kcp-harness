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
  type SignatureResult,
} from "kcp-agent";
import type { GateVerdict } from "kcp-agent";
import type { GovernancePolicy, GovernedDomain, ApprovalRule } from "./config.js";
import type { Classification } from "./classifier.js";
import { matchesPrefix } from "./classifier.js";
import type { SessionState, ApprovedPlan } from "./session.js";
import { isPathApproved, addPlan, recordSpend } from "./session.js";
import type { SpendResult } from "./budget-ledger.js";
import {
  latestForCall,
  newRequest,
  parseDuration,
  type ApprovalProvider,
  type ApprovalResolution,
} from "./approval.js";

/** Approval wiring the proxy hands to the governor: the store + the rules. */
export interface ApprovalContext {
  provider: ApprovalProvider;
  rules: ApprovalRule[];
}

/** The governor's decision for a tool call. */
export interface GovernanceDecision {
  /** Whether the tool call is approved. */
  approved: boolean;
  /** How the decision was made. */
  mode: "plan-first" | "auto-plan" | "kcp-passthrough" | "blocked"
    | "pending"          // awaiting a named human — approved stays false (fail-closed)
    | "human-approved";  // a named human resolved it — resolution attached
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
  /** Manifest signature verification result (when signature checking is active). */
  signature?: SignatureResult;
  /** Ticket id, when mode is "pending". */
  pendingId?: string;
  /** True when this call opened a new ticket (the proxy audits approval_requested). */
  submitted?: boolean;
  /** The named human's resolution, when mode is "human-approved". */
  resolution?: ApprovalResolution;
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
  approvals?: ApprovalContext,
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

  // Mode 0: human-approval rules outrank every automated path. A matched
  // rule means a named human decides — an approved plan must not bypass it.
  if (approvals) {
    const rule = approvals.rules.find((r) => ruleMatches(r, toolName, target));
    if (rule) {
      try {
        return await governByApproval(rule, toolName, target ?? "", session, domain, approvals.provider);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Fail-closed: if the approval store is unreachable we cannot prove
        // a human signed off, so the call is blocked.
        return { approved: false, mode: "blocked", reason: `approval check failed (fail-closed): ${msg}` };
      }
    }
  }

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

/** Does an approval rule apply to this call? Present criteria AND together. */
function ruleMatches(rule: ApprovalRule, toolName: string, target: string | undefined): boolean {
  if (rule.match.tools && !rule.match.tools.includes(toolName)) return false;
  if (rule.match.paths) {
    if (!target) return false;
    if (!rule.match.paths.some((p) => matchesPrefix(target, p))) return false;
  }
  return true;
}

/**
 * Decide a rule-matched call from the approval store:
 * approved → allow with the resolution attached; pending → wait;
 * dismissed → terminal block; expired or absent → open a fresh ticket.
 */
async function governByApproval(
  rule: ApprovalRule,
  toolName: string,
  target: string,
  session: SessionState,
  domain: GovernedDomain,
  provider: ApprovalProvider,
): Promise<GovernanceDecision> {
  const existing = await latestForCall(provider, target, toolName);

  if (existing?.state === "approved" && existing.resolution) {
    return {
      approved: true,
      mode: "human-approved",
      resolution: existing.resolution,
      reason:
        `approved by ${existing.resolution.reviewer} at ${existing.resolution.reviewedAt} ` +
        `(${existing.resolution.policyRef}) — ticket ${existing.request.id}`,
    };
  }

  if (existing?.state === "pending_review") {
    return {
      approved: false,
      mode: "pending",
      pendingId: existing.request.id,
      reason:
        `pending approval ${existing.request.id} from role ${existing.request.requiredRole} — ` +
        `re-try after approval or check harness_approvals`,
    };
  }

  if (existing?.state === "dismissed" && existing.resolution) {
    return {
      approved: false,
      mode: "blocked",
      reason:
        `dismissed by ${existing.resolution.reviewer}` +
        `${existing.resolution.note ? `: ${existing.resolution.note}` : ""} — ticket ${existing.request.id}`,
    };
  }

  // No usable ticket (none yet, or the last one expired) → open a fresh one.
  const request = newRequest({
    sessionId: session.id,
    toolName,
    target,
    task: `${toolName} ${target}`.trim(),
    requiredRole: rule.required_role,
    expiresAt: rule.expires_after
      ? new Date(Date.now() + parseDuration(rule.expires_after)).toISOString()
      : undefined,
    evidence: {
      manifest: domain.manifest,
      policyRef: rule.policy_ref,
      detail: existing?.state === "expired" ? `previous ticket ${existing.request.id} expired` : undefined,
    },
  });
  await provider.submit(request);

  return {
    approved: false,
    mode: "pending",
    pendingId: request.id,
    submitted: true,
    reason:
      `pending approval ${request.id} from role ${rule.required_role}` +
      `${rule.policy_ref ? ` (${rule.policy_ref})` : ""} — ` +
      `re-try after approval or check harness_approvals`,
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
      signature: tree.signature,
    };
  }

  // Signature enforcement: if required, block on non-verified signatures
  if (policy.signature_required && tree.signature?.status !== "verified") {
    const status = tree.signature?.status ?? "unsigned";
    const detail = tree.signature?.detail ?? "no signing block in manifest";
    return {
      approved: false,
      mode: "blocked",
      reason: `manifest signature ${status}: ${detail}`,
      signature: tree.signature,
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
          signature: tree.signature,
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
      signature: tree.signature,
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
      signature: tree.signature,
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
    signature: tree.signature,
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
    requireSignature: policy.signature_required ?? false,
    trustedKey: policy.trusted_keys?.[0],  // FollowOptions takes a single key
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

// -- Skill/procedure eligibility (#100) --------------------------------------

/** The planner's skill_eligibility verdict for a governed skill invocation. */
export interface SkillEligibility {
  /** Whether the skill_eligibility gate admitted the skill (fail-closed). */
  eligible: boolean;
  /** The written reason — the deciding gate's `detail`, never reconstructed. */
  reason: string;
  /** The gate that decided (skill_eligibility, or the earlier gate that rejected). */
  gate: string;
  /** The skill unit id that was gated. */
  skillId: string;
  /** The skill's declared action scope, when the unit declares one. */
  actionScope?: { tools?: string[]; paths?: string[]; capabilities?: string[] };
}

/**
 * Run a governed skill invocation through the planner's `skill_eligibility`
 * gate. Reuses the same deterministic kcp-agent planner the governor uses: it
 * loads the domain's manifest, traces the skill task, and reads the
 * skill_eligibility verdict for the named unit.
 *
 * Fail-closed everywhere: no skill id, an unknown unit, a unit that isn't
 * `kind: skill`, a manifest error, or a gate that did not explicitly pass all
 * yield `eligible: false` with a specific reason. A skill unit that was
 * rejected by an earlier gate never reaches skill_eligibility in the trace —
 * that earlier gate's detail becomes the reason.
 */
export async function assessSkillEligibility(
  domain: GovernedDomain,
  skillId: string | undefined,
  session: SessionState,
  policy: GovernancePolicy,
): Promise<SkillEligibility> {
  if (!skillId) {
    return { eligible: false, reason: "skill invocation carries no skill id — blocked", gate: "skill_eligibility", skillId: "" };
  }
  if (!domain.manifest) {
    return { eligible: false, reason: "governed skill domain has no manifest — blocked", gate: "skill_eligibility", skillId };
  }

  const manifest = await loadManifest(domain.manifest);
  const unit = manifest.units.find((u) => u.id === skillId);
  if (!unit) {
    return { eligible: false, reason: `no unit "${skillId}" in ${domain.manifest}`, gate: "skill_eligibility", skillId };
  }
  if (unit.kind !== "skill") {
    return { eligible: false, reason: `unit "${skillId}" is not kind: skill — not invoke-eligible`, gate: "skill_eligibility", skillId, actionScope: unit.action_scope };
  }

  // Trace the skill against its own intent so the relevance gate matches and
  // the skill_eligibility verdict is the deciding one. The task is the unit's
  // declared purpose — the skill is what we are gating, not an arbitrary query.
  const options = buildFollowOptions(policy, session).planOptions;
  const task = unit.intent || `invoke skill ${skillId}`;
  const dt = traceDecision(manifest, task, options);
  const ut = dt.units.find((u) => u.id === skillId);

  if (!ut) {
    return { eligible: false, reason: `skill "${skillId}" produced no trace verdict — blocked`, gate: "skill_eligibility", skillId, actionScope: unit.action_scope };
  }

  const skillGate: GateVerdict | undefined = ut.gates.find((g) => g.gate === "skill_eligibility");
  const rejecting: GateVerdict | undefined = ut.rejectedBy ? ut.gates.find((g) => g.gate === ut.rejectedBy) : undefined;

  // Fail-closed authority: a skill is invoke-eligible only when the planner
  // admits its unit as load-eligible (`load_eligible: true`). The gate's
  // per-unit `passed` flag is contextual — it blocks selection only under
  // strict mode — so the plan's `loadEligible` is the honest signal. The
  // skill_eligibility gate still supplies the written reason; if an earlier
  // gate rejected the unit, that gate's detail is the reason.
  const planned = dt.plan.selected.find((u) => u.id === skillId);
  const eligible = planned?.loadEligible === true;
  const deciding = skillGate ?? rejecting;
  const reason = deciding?.detail ?? `skill "${skillId}" has no skill_eligibility verdict — blocked`;

  return {
    eligible,
    reason,
    gate: deciding?.gate ?? "skill_eligibility",
    skillId,
    actionScope: unit.action_scope,
  };
}

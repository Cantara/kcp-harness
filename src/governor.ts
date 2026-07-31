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
  plan as planManifest,
  parseManifest,
  verifyManifestText,
  loadPlannedUnits,
  loadManifest,
  trace as traceDecision,
  type AgentPlan,
  type DecisionTrace,
  type PlanOptions,
  type FollowOptions,
  type SignatureResult,
  type Manifest,
} from "kcp-agent";
import type { GateVerdict } from "kcp-agent";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { GovernancePolicy, GovernedDomain, ApprovalRule } from "./config.js";
import type { ProhibitedAttempt } from "./conformance.js";
import type { Classification } from "./classifier.js";
import { matchesPrefix } from "./classifier.js";
import type { SessionState, ApprovedPlan } from "./session.js";
import { isPathApproved, addPlan, recordSpend } from "./session.js";
import type { SpendResult } from "./budget-ledger.js";
import { deriveCorrelation, traceparentFromArgs } from "./correlation.js";
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

/**
 * A manifest supplied to the governor in-memory, so it can govern without
 * reading `node:fs` — for browser, sidecar, remote, and in-process hosts where
 * the manifest is already resolved. Fully additive: when a caller passes none,
 * the governor loads from `domain.manifest` exactly as before.
 *
 * Two shapes: an already-parsed `Manifest` model, or the raw YAML `text`
 * (parsed here, with the original signable bytes still available for signature
 * verification when `source` locates any detached key/signature).
 */
export type InMemoryManifest = Manifest | { text: string; source?: string };

/** A parsed Manifest carries a `units` array; the text form does not. */
function isParsedManifest(m: InMemoryManifest): m is Manifest {
  return Array.isArray((m as Manifest).units);
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
  /**
   * The deny-hit that decided this call, when an `action_scope.deny` held it
   * (RFC-0030 / KCP 0.32, §4.3b): the denied token, dimension, and binding
   * source(s) — the skill's deny, the enclosing playbook's, or both. A deny is
   * never grantable: when this is set, `approved` is false, no pending ticket
   * exists, and no approval resolution may enact the action.
   */
  prohibited?: ProhibitedAttempt;
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
  manifestSource?: InMemoryManifest,
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
        return await governByApproval(
          rule,
          toolName,
          target ?? "",
          session,
          domain,
          approvals.provider,
          // Same reduction the audit path uses, from the same args — one source of truth
          // for what this call's correlation is.
          traceparentFromArgs(args) ? deriveCorrelation(args).correlationId : undefined,
        );
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

  // Mode 2: auto-plan — create a governance plan on the fly. An in-memory
  // manifest is a first-class source alongside domain.manifest (path/URL).
  if (target && (domain.manifest || manifestSource)) {
    try {
      const autoPlan = await autoGovern(target, domain, session, policy, manifestSource);
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
  correlationId?: string,
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
    ...(correlationId ? { correlationId } : {}),
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
  manifestSource?: InMemoryManifest,
): Promise<GovernanceDecision> {
  const followOptions = buildFollowOptions(policy, session);

  // Use the target path as the task — the planner will score units
  // against this and select the most relevant ones.
  const task = `access ${target}`;
  // Resolve the plan from whichever source the caller supplied: a pre-parsed /
  // in-memory manifest (no fs) or the domain's manifest path/URL (fs/network).
  const resolved = manifestSource
    ? await planFromMemory(manifestSource, task, followOptions)
    : await planFromLocation(domain.manifest, task, followOptions);

  if (resolved.error) {
    return {
      approved: false,
      mode: "blocked",
      reason: `manifest error: ${resolved.error}`,
      signature: resolved.signature,
    };
  }

  // Signature enforcement: if required, block on non-verified signatures
  if (policy.signature_required && resolved.signature?.status !== "verified") {
    const status = resolved.signature?.status ?? "unsigned";
    const detail = resolved.signature?.detail ?? "no signing block in manifest";
    return {
      approved: false,
      mode: "blocked",
      reason: `manifest signature ${status}: ${detail}`,
      signature: resolved.signature,
    };
  }

  const rootPlan = resolved.rootPlan;

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
          signature: resolved.signature,
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
      signature: resolved.signature,
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
      signature: resolved.signature,
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
    signature: resolved.signature,
    reason: `auto-plan blocked: ${skipReason}`,
  };
}

/** The root plan of an auto-govern resolution — from disk/network or memory. */
interface ResolvedPlan {
  rootPlan?: AgentPlan;
  signature?: SignatureResult;
  /** Fetch/parse/signature failure — fail-closed, same as planTree's node.error. */
  error?: string;
}

/** Resolve the root plan from a manifest path/URL — the original fs/network path. */
async function planFromLocation(
  location: string,
  task: string,
  followOptions: FollowOptions,
): Promise<ResolvedPlan> {
  const tree = await planTree(location, task, followOptions);
  return {
    rootPlan: Array.from(plans(tree))[0],
    signature: tree.signature,
    error: tree.error,
  };
}

/**
 * Resolve the root plan from an in-memory manifest — no `node:fs`. Mirrors the
 * root-node handling in kcp-agent's planTree so the decision is identical to the
 * fs path: parse (when given text), verify the signature against the signable
 * bytes, then run the same pure planner. Fail-closed on parse/signature errors.
 *
 * A pre-parsed `Manifest` has no signable bytes to re-verify; when the policy
 * requires a verified signature, that source is refused (unverifiable) rather
 * than silently admitted — supply the raw `text` form to carry a signature.
 */
async function planFromMemory(
  src: InMemoryManifest,
  task: string,
  followOptions: FollowOptions,
): Promise<ResolvedPlan> {
  let manifest: Manifest;
  let text: string | undefined;
  let source: string | undefined;

  if (isParsedManifest(src)) {
    manifest = src;
    source = src.source;
  } else {
    text = src.text;
    source = src.source;
    try {
      manifest = parseManifest(text, source);
    } catch (e) {
      return { error: `manifest parse error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  let signature: SignatureResult | undefined;
  if (text !== undefined) {
    signature = await verifyManifestText(text, manifest.signing, source, {
      ...(followOptions.trustedKey ? { trustedKey: followOptions.trustedKey } : {}),
      ...(followOptions.fetchGuard ? { fetchGuard: followOptions.fetchGuard } : {}),
    });
    if (signature.status === "invalid") {
      return { signature, error: `signature invalid: ${signature.detail}` };
    }
    if (followOptions.requireSignature && signature.status !== "verified") {
      return { signature, error: `signature required but ${signature.status}: ${signature.detail}` };
    }
  } else if (followOptions.requireSignature) {
    // A pre-parsed manifest carries no bytes to verify — fail-closed.
    signature = { status: "unverifiable", detail: "in-memory manifest supplied without signable text" };
    return { signature, error: `signature required but unverifiable: ${signature.detail}` };
  }

  const rootPlan = planManifest(manifest, task, followOptions.planOptions);
  rootPlan.signature = signature;
  return { rootPlan, signature };
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
  /**
   * The gated unit's declared kind, when the unit exists. The proxy needs it to
   * tell a `kind: playbook` from a `kind: skill` at load time: an enacted
   * playbook's `action_scope.deny` blankets every subsequent step (RFC-0030 /
   * KCP 0.32, §4.3b), so the two kinds wire into session state differently.
   */
  kind?: string;
  /** The skill's declared action scope, when the unit declares one. */
  actionScope?: {
    tools?: string[];
    paths?: string[];
    capabilities?: string[];
    spend?: { max_spend?: number; allowed_vendors?: string[]; currency?: string };
    /** Explicit prohibitions that override the allowlist, fail-closed (RFC-0029 / KCP 0.31). */
    deny?: { tools?: string[]; paths?: string[]; capabilities?: string[] };
  };
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
/**
 * Coerce a spend amount the same way kcp-agent's own manifest parser does
 * (`Number(v)`, not a strict `typeof === "number"` check) — so a quoted
 * numeric YAML value (`max_spend: "50"`) still ends up as a real ceiling
 * instead of silently disabling the amount check downstream in
 * checkConformance, which only enforces max_spend when it is a number.
 */
function asSpendAmount(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Recover the `action_scope` sub-fields kcp-agent's parser drops from the raw
 * manifest YAML text: the `spend` envelope (#139) and the `deny` negative scope
 * (RFC-0029 / KCP 0.31). kcp-agent preserves only tools/paths/capabilities under
 * action_scope, so both are read back here and merged onto the parsed scope.
 * Recovering `deny` is load-bearing, not cosmetic — the conformance gate can only
 * enforce a prohibition it can see, so a dropped `deny` would silently fail OPEN.
 */
function spendScopeFromText(
  base: { tools?: string[]; paths?: string[]; capabilities?: string[] } | undefined,
  rawText: string,
  skillId: string,
): SkillEligibility["actionScope"] {
  const raw = yaml.load(rawText) as
    | { units?: Array<Record<string, unknown>> }
    | undefined;
  const unit = raw?.units?.find((u) => u["id"] === skillId);
  const scope = unit && typeof unit["action_scope"] === "object" ? (unit["action_scope"] as Record<string, unknown>) : undefined;

  const spendRaw = scope && typeof scope["spend"] === "object" ? (scope["spend"] as Record<string, unknown>) : undefined;
  let spend: { max_spend?: number; allowed_vendors?: string[]; currency?: string } | undefined;
  if (spendRaw) {
    const s: { max_spend?: number; allowed_vendors?: string[]; currency?: string } = {};
    const maxSpend = asSpendAmount(spendRaw["max_spend"]);
    if (maxSpend !== undefined) s.max_spend = maxSpend;
    if (Array.isArray(spendRaw["allowed_vendors"])) s.allowed_vendors = (spendRaw["allowed_vendors"] as unknown[]).map(String);
    if (typeof spendRaw["currency"] === "string") s.currency = spendRaw["currency"] as string;
    if (s.max_spend !== undefined || s.allowed_vendors !== undefined || s.currency !== undefined) spend = s;
  }

  // deny (RFC-0029 / KCP 0.31): the explicit negative scope, same shape as the
  // allowlist. Each dimension recovered only when it is a string array.
  const denyRaw = scope && typeof scope["deny"] === "object" ? (scope["deny"] as Record<string, unknown>) : undefined;
  let deny: { tools?: string[]; paths?: string[]; capabilities?: string[] } | undefined;
  if (denyRaw) {
    const d: { tools?: string[]; paths?: string[]; capabilities?: string[] } = {};
    for (const dim of ["tools", "paths", "capabilities"] as const) {
      if (Array.isArray(denyRaw[dim])) d[dim] = (denyRaw[dim] as unknown[]).map(String);
    }
    if (d.tools || d.paths || d.capabilities) deny = d;
  }

  if (!spend && !deny) return base;
  return { ...(base ?? {}), ...(spend ? { spend } : {}), ...(deny ? { deny } : {}) };
}

function withSpendScope(
  base: { tools?: string[]; paths?: string[]; capabilities?: string[] } | undefined,
  manifestPath: string,
  skillId: string,
): SkillEligibility["actionScope"] {
  try {
    return spendScopeFromText(base, readFileSync(manifestPath, "utf-8"), skillId);
  } catch {
    return base;
  }
}

/**
 * Recover the dropped action_scope sub-fields from an in-memory manifest source —
 * no `node:fs`. The raw `text` form still carries the bytes the parser drops, so
 * the spend envelope and deny negative scope survive; a pre-parsed `Manifest` has
 * no bytes to re-read, so the base scope stands (identical to the remote-URL case
 * withSpendScope already handles fail-safe). Best-effort: any parse failure yields
 * the base scope.
 */
function withSpendScopeFromSource(
  base: { tools?: string[]; paths?: string[]; capabilities?: string[] } | undefined,
  source: InMemoryManifest,
  skillId: string,
): SkillEligibility["actionScope"] {
  if (isParsedManifest(source)) return base;
  try {
    return spendScopeFromText(base, source.text, skillId);
  } catch {
    return base;
  }
}

/**
 * Kinds this harness treats as governed procedures — things that *act*, and so must
 * carry an explicit eligibility grant before an agent may invoke them.
 *
 * `playbook` joined in KCP v0.29 (§4.3b). It is deliberately a set rather than a chain
 * of `||` comparisons: the same condition exists in kcp-agent's planner and trace, and
 * the one time it was written as a literal equality check a playbook slipped past it
 * (kcp-agent#118).
 */
const GOVERNED_KINDS = new Set(["skill", "playbook"]);

export async function assessSkillEligibility(
  domain: GovernedDomain,
  skillId: string | undefined,
  session: SessionState,
  policy: GovernancePolicy,
  manifestSource?: InMemoryManifest,
): Promise<SkillEligibility> {
  if (!skillId) {
    return { eligible: false, reason: "skill invocation carries no skill id — blocked", gate: "skill_eligibility", skillId: "" };
  }
  // A manifest can arrive as a path/URL (fs/network) or in-memory (browser,
  // sidecar, in-process) — either satisfies the "has a manifest" precondition.
  if (!domain.manifest && !manifestSource) {
    return { eligible: false, reason: "governed skill domain has no manifest — blocked", gate: "skill_eligibility", skillId };
  }

  let manifest: Manifest;
  if (manifestSource) {
    try {
      manifest = isParsedManifest(manifestSource)
        ? manifestSource
        : parseManifest(manifestSource.text, manifestSource.source);
    } catch (e) {
      return { eligible: false, reason: `manifest parse error: ${e instanceof Error ? e.message : String(e)}`, gate: "skill_eligibility", skillId };
    }
  } else {
    manifest = await loadManifest(domain.manifest);
  }
  const manifestLabel = domain.manifest || manifest.source || "in-memory manifest";
  const unit = manifest.units.find((u) => u.id === skillId);
  if (!unit) {
    return { eligible: false, reason: `no unit "${skillId}" in ${manifestLabel}`, gate: "skill_eligibility", skillId };
  }
  // Merge back the spend envelope kcp-agent's parser drops (#139).
  const actionScope = manifestSource
    ? withSpendScopeFromSource(unit.action_scope, manifestSource, skillId)
    : withSpendScope(unit.action_scope, domain.manifest, skillId);
  // Governed procedures are kind: skill and, since KCP v0.29, kind: playbook (§4.3b).
  // A playbook is an ordered composition of units governed per step — a procedure by
  // every criterion that put skills behind this gate, and one that reaches `commit` by
  // design.
  //
  // The previous test was `kind !== "skill"`. That fail-closed on playbooks and was
  // therefore safe, but it refused them for the wrong reason: it could not tell "this
  // composition has no grant" from "this is not a procedure at all". A playbook carrying
  // an explicit load_eligible: true was refused identically to one carrying nothing, so
  // the harness could not represent a decision a human had actually made, and the audit
  // trail recorded a category statement where a governance verdict belonged. Safe and
  // useless is still a bug.
  //
  // This is the third copy of the condition in the stack: kcp-agent's planner produces
  // the canonical plan, its trace reimplements the cascade for per-gate verdicts, and
  // this decides at the proxy boundary. kcp-agent#118 is what their drift costs.
  if (!GOVERNED_KINDS.has(unit.kind ?? "")) {
    return { eligible: false, reason: `unit "${skillId}" is kind: ${unit.kind ?? "knowledge"} — not a governed procedure, not invoke-eligible`, gate: "skill_eligibility", skillId, kind: unit.kind, actionScope };
  }

  // Trace the skill against its own intent so the relevance gate matches and
  // the skill_eligibility verdict is the deciding one. The task is the unit's
  // declared purpose — the skill is what we are gating, not an arbitrary query.
  const options = buildFollowOptions(policy, session).planOptions;
  const task = unit.intent || `invoke skill ${skillId}`;
  const dt = traceDecision(manifest, task, options);
  const ut = dt.units.find((u) => u.id === skillId);

  if (!ut) {
    return { eligible: false, reason: `skill "${skillId}" produced no trace verdict — blocked`, gate: "skill_eligibility", skillId, kind: unit.kind, actionScope };
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
    kind: unit.kind,
    actionScope,
  };
}

// Procedural conformance gate — "grounding for actions" (#39).
//
// kcp-agent's ground.ts grounds an *answer*: every claim must be a member of
// the units the planner allowed to load, or it is surfaced as a gap and held.
// This module grounds an *action*: once a governed skill is loaded, every
// subsequent governed tool call must stay within that skill's declared
// `action_scope`. An action that touches a tool, path, or capability the skill
// never declared is out of scope — surfaced as a gap and held, exactly as an
// ungrounded claim is.
//
// The adjudication is a pure, deterministic, side-effect-free function — the
// same discipline as groundAnswer: a proposal (the observed action) is checked
// against an authority (the skill's scope), and a binary verdict with a
// written, specific reason is returned. Fail-closed: an absent or unparseable
// scope authorizes nothing.
//
// The verdict reuses the gates' GateVerdict contract ({gate, passed, detail})
// the same way kcp-agent's ConfidenceVerdict does — here `reason` carries the
// detail and `evidence` pins the inputs the decision was made from.
//
// This adjudicator is exported from the package root so both the proxy (which
// checks the agent's tool calls) and the pi-kcp runtime's ConformanceChecker
// (which checks the runtime's actions) share ONE deterministic decision.

import { normalizePath, matchesPrefix } from "./classifier.js";

/**
 * A governed skill's declared action scope — the tools, paths, and capabilities
 * a procedure is permitted to touch when invoked (KCP `Unit.action_scope`, #100).
 */
export interface ActionScope {
  tools?: string[];
  paths?: string[];
  capabilities?: string[];
  /**
   * Spend authority for a governed procedure that transacts value (#139). A
   * PURCHASE action is held unless its vendor, currency, and amount all fall
   * within the declared envelope. Each sub-field is an independent allowlist:
   * an omitted sub-field does not constrain that facet.
   */
  spend?: {
    /** Maximum single-purchase amount, in `currency`. */
    max_spend?: number;
    /** Allowlist of vendors this skill may transact with. */
    allowed_vendors?: string[];
    /** The only currency this skill may spend in. */
    currency?: string;
  };
}

/**
 * One action observed after a skill was loaded — the tool invoked and the
 * targets it reaches. The proxy builds this from `classifier.extractTargets`;
 * the runtime seam supplies it directly.
 */
export interface ObservedAction {
  /** The tool (or procedure step) invoked. */
  tool: string;
  /** File-path targets the action reaches (from extractTargets). */
  paths?: string[];
  /** URL targets the action reaches (from extractTargets). */
  urls?: string[];
  /** Capabilities the action asserts, when the caller can name them. */
  capabilities?: string[];
  /**
   * A purchase the action performs — a governed spend of value (#139). Present
   * only for a buy: the vendor paid, the amount, and the currency. When set and
   * the active skill declares `spend`, the purchase is checked against that
   * envelope (vendor allowlist, currency, max_spend).
   */
  purchase?: {
    /** The vendor being paid. */
    vendor: string;
    /** The amount being spent, in `currency`. */
    amount: number;
    /** The currency of the amount. */
    currency: string;
  };
}

/**
 * The conformance gate's verdict. Binary, with a written, specific reason — the
 * same GateVerdict contract kcp-agent's ConfidenceVerdict reuses. `evidence`
 * pins the inputs the decision was made from (the action's tool + the specific
 * deciding target, and the authorized scope), so a reviewer can reconstruct the
 * adjudication without re-running it.
 */
export interface ConformanceVerdict {
  gate: "conformance";
  passed: boolean;
  /** Written, specific reason — names the violating target on failure. */
  reason: string;
  /** Raw inputs, preserved for audit — never reconstructed from logs later. */
  evidence?: {
    /** The tool the observed action invoked. */
    tool: string;
    /** The deciding target: the violating one on failure, the checked one on pass. */
    target?: string;
    /** The skill's authorized tools, pinned at check time. */
    scopeTools?: string[];
    /** The skill's authorized path/URL prefixes, pinned. */
    scopePaths?: string[];
    /** The skill's authorized capabilities, pinned. */
    scopeCapabilities?: string[];
    /** The skill's declared spend envelope, pinned when a purchase was checked (#139). */
    scopeSpend?: { max_spend?: number; allowed_vendors?: string[]; currency?: string };
    /** The purchase the action performed, pinned when one was checked (#139). */
    purchase?: { vendor: string; amount: number; currency: string };
  };
}

function isNonEmpty(a: string[] | undefined): a is string[] {
  return Array.isArray(a) && a.length > 0;
}

/** A spend envelope is declared when at least one of its sub-fields is present. */
function spendDeclared(spend: ActionScope["spend"]): spend is NonNullable<ActionScope["spend"]> {
  if (!spend || typeof spend !== "object") return false;
  return (
    typeof spend.max_spend === "number" ||
    isNonEmpty(spend.allowed_vendors) ||
    typeof spend.currency === "string"
  );
}

/** A scope is parseable when it declares at least one dimension. */
function hasScope(scope: ActionScope | undefined | null): scope is ActionScope {
  if (!scope || typeof scope !== "object") return false;
  return (
    isNonEmpty(scope.tools) ||
    isNonEmpty(scope.paths) ||
    isNonEmpty(scope.capabilities) ||
    spendDeclared(scope.spend)
  );
}

/** A target with a URL scheme (http://, https://, …) is matched by raw prefix. */
function isUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

/**
 * A target is within a set of authorized prefixes when it matches a filesystem
 * prefix at a directory boundary (paths) or, for a URL target, begins with a
 * declared prefix — the same matching the classifier uses for governed domains.
 * Filesystem targets are normalized first (resolving `../`) so a traversal
 * escape cannot slip past on its raw spelling.
 */
function targetInPrefixes(target: string, prefixes: string[]): boolean {
  const norm = normalizePath(target);
  return prefixes.some(
    (p) => matchesPrefix(norm, normalizePath(p)) || (isUrl(target) && target.startsWith(p)),
  );
}

/**
 * Adjudicate one observed action against an authorized skill's action scope.
 *
 * Pure and deterministic — no I/O, no LLM. Each declared dimension of the scope
 * is an allowlist: when the scope declares `tools`, the action's tool must be a
 * member; when it declares `paths`, every path/URL the action reaches must be
 * under an authorized prefix; when it declares `capabilities` and the action
 * asserts one, it must be authorized. A dimension the scope does not declare
 * does not constrain that facet — but a scope that declares *nothing* (absent or
 * unparseable) authorizes nothing and every action is held (fail-closed).
 *
 * @returns `passed:true` when the action is wholly within scope; otherwise
 * `passed:false` with a reason naming the specific violating target.
 */
export function checkConformance(action: ObservedAction, scope: ActionScope): ConformanceVerdict {
  const pins = {
    tool: action.tool,
    scopeTools: scope?.tools,
    scopePaths: scope?.paths,
    scopeCapabilities: scope?.capabilities,
    ...(spendDeclared(scope?.spend) ? { scopeSpend: scope!.spend } : {}),
    ...(action.purchase ? { purchase: action.purchase } : {}),
  };

  // Fail-closed: an absent or unparseable scope authorizes nothing.
  if (!hasScope(scope)) {
    return {
      gate: "conformance",
      passed: false,
      reason: `the active skill declares no action_scope — fail-closed; action "${action.tool}" is held for review`,
      evidence: { ...pins },
    };
  }

  // Tool dimension — allowlist when declared.
  if (isNonEmpty(scope.tools) && !scope.tools.includes(action.tool)) {
    return {
      gate: "conformance",
      passed: false,
      reason: `tool "${action.tool}" is outside the skill's authorized tools [${scope.tools.join(", ")}]`,
      evidence: { ...pins, target: action.tool },
    };
  }

  // Path/URL dimension — every target the action reaches must be authorized.
  const targets = [...(action.paths ?? []), ...(action.urls ?? [])];
  if (isNonEmpty(scope.paths)) {
    for (const target of targets) {
      if (!targetInPrefixes(target, scope.paths)) {
        return {
          gate: "conformance",
          passed: false,
          reason: `target "${target}" is outside the skill's authorized paths [${scope.paths.join(", ")}]`,
          evidence: { ...pins, target },
        };
      }
    }
  }

  // Capability dimension — allowlist when declared and the action asserts one.
  if (isNonEmpty(scope.capabilities) && isNonEmpty(action.capabilities)) {
    for (const cap of action.capabilities) {
      if (!scope.capabilities.includes(cap)) {
        return {
          gate: "conformance",
          passed: false,
          reason: `capability "${cap}" is outside the skill's authorized capabilities [${scope.capabilities.join(", ")}]`,
          evidence: { ...pins, target: cap },
        };
      }
    }
  }

  // Spend dimension (#139) — a purchase is an allowlist over vendor, currency,
  // and amount. A buy requires explicit spend authority: a scope that declares
  // no `spend` envelope grants none, so the purchase is held fail-closed even
  // when the skill authorized the buying tool. When the envelope is present,
  // each facet is checked only if the skill declares it; the first violation
  // holds the buy with a written reason naming the deciding facet.
  if (action.purchase) {
    const { vendor, amount, currency } = action.purchase;

    if (!spendDeclared(scope.spend)) {
      return {
        gate: "conformance",
        passed: false,
        reason: `purchase of ${amount} ${currency} to "${vendor}" but the active skill declares no spend authority — fail-closed`,
        evidence: { ...pins, target: vendor },
      };
    }
    const s = scope.spend;

    if (isNonEmpty(s.allowed_vendors) && !s.allowed_vendors.includes(vendor)) {
      return {
        gate: "conformance",
        passed: false,
        reason: `vendor "${vendor}" is outside the skill's authorized vendors [${s.allowed_vendors.join(", ")}]`,
        evidence: { ...pins, target: vendor },
      };
    }

    if (typeof s.currency === "string" && currency !== s.currency) {
      return {
        gate: "conformance",
        passed: false,
        reason: `currency mismatch: purchase in ${currency}, scope allows ${s.currency}`,
        evidence: { ...pins, target: currency },
      };
    }

    if (typeof s.max_spend === "number" && amount > s.max_spend) {
      return {
        gate: "conformance",
        passed: false,
        reason: `purchase of ${amount} ${currency} to "${vendor}" exceeds max_spend ${s.max_spend} ${currency}`,
        evidence: { ...pins, target: vendor },
      };
    }
  }

  const checked = action.purchase?.vendor ?? targets[0] ?? action.tool;
  return {
    gate: "conformance",
    passed: true,
    reason: `action "${action.tool}"${targets.length ? ` on ${targets.join(", ")}` : ""} is within the active skill's declared action_scope`,
    evidence: { ...pins, target: checked },
  };
}

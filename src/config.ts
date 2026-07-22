// Harness configuration — governed domains, policies, downstream servers.
//
// The harness reads a YAML config that declares which knowledge domains are
// governed (by manifest + path/URL prefixes), what policy to enforce, and
// which downstream MCP servers to proxy. Everything else passes through.

import { readFileSync } from "node:fs";
import yaml from "js-yaml";

/** A knowledge domain governed by a KCP manifest. */
export interface GovernedDomain {
  /** Path or URL to the knowledge.yaml that governs this domain. */
  manifest: string;
  /** File path prefixes under governance (relative to the project root). */
  paths?: string[];
  /** URL prefixes under governance. */
  urls?: string[];
  /** Specific tool names that are always governed in this domain. */
  tools?: string[];
}

/** Governance policy — what happens when a governed domain is accessed. */
export interface GovernancePolicy {
  /** Block access to governed paths without plan approval (default: true). */
  fail_closed: boolean;
  /** Log all tool calls, not just governed ones (default: true). */
  audit_all: boolean;
  /** Money budget ceiling for the session. */
  budget?: { amount: number; currency?: string };
  /** Token ceiling for context window. */
  context_budget?: number;
  /** Cap on selected units per plan (default: 5). */
  max_units?: number;
  /** Fail-closed: drop non-eligible units from plan instead of listing them. */
  strict?: boolean;
  /** Environment for federation context selection (dev/test/staging/prod). */
  env?: string;
  /** Require verified signatures on all manifests (default: false). */
  signature_required?: boolean;
  /** Trusted public keys for signature verification (paths, URLs, or inline). */
  trusted_keys?: string[];
}

/** A rule demanding human approval for matching governed calls. */
export interface ApprovalRule {
  /** What the rule applies to. Absent criteria match everything; present criteria AND together. */
  match: {
    /** Tool names (exact), e.g. [Write, Edit]. */
    tools?: string[];
    /** Path prefixes, matched like governed-domain paths. */
    paths?: string[];
  };
  /** Role that must approve (recorded on the ticket; enforcement is channel-side). */
  required_role: string;
  /** TTL after which an unresolved ticket expires ("30m", "72h", "7d"). */
  expires_after?: string;
  /** Policy/regulatory citation this rule enforces — carried as ticket evidence. */
  policy_ref?: string;
}

/** Human-approval configuration — org policy, deliberately not manifest data. */
export interface ApprovalsConfig {
  /** Ticket store: "file" (persisted, default) or "memory" (ephemeral). */
  provider: "file" | "memory";
  /** Directory for the file provider's store (default: .kcp-harness/approvals). */
  dir?: string;
  /** Rules evaluated before any automated governance path. */
  rules: ApprovalRule[];
  /**
   * Require an ed25519 signature on every resolution (default: false). When
   * true, resolving a ticket fails closed if the signature is missing or
   * invalid — an unsigned resolution is not a valid resolution.
   */
  require_signed_resolutions?: boolean;
  /**
   * Trusted reviewer public keys (paths or inline PEM/base64/hex). When set, a
   * signature must verify against one of these to bind it to an identity; when
   * omitted, the signature's embedded key is used (integrity, not identity).
   */
  trusted_keys?: string[];
}

/** Default approvals store directory. */
export const DEFAULT_APPROVALS_DIR = ".kcp-harness/approvals";

/**
 * Confidence-gate configuration for harness_assess — org policy for when a
 * synthesized conclusion may be acted on (kcp-agent's assess() decides,
 * the harness enforces).
 */
export interface ConfidenceConfig {
  /** Pass/fail line, 0..1. A caller may tighten it, never loosen it. */
  threshold: number;
  /** Severity label recorded on verdicts (e.g. "critical"). */
  severity?: string;
  /** Route failed verdicts to this approval role (requires governance.approvals). */
  route_to_role?: string;
  /** TTL for routed tickets ("30m", "72h", "7d"). */
  expires_after?: string;
  /** Policy citation carried as ticket evidence. */
  policy_ref?: string;
}

/** A downstream MCP server to proxy tool calls to. */
export interface DownstreamConfig {
  /** Human-readable name for this downstream server. */
  name: string;
  /** Command to spawn the server. */
  command: string;
  /** Arguments to the command. */
  args?: string[];
  /** Extra environment variables. */
  env?: Record<string, string>;
}

/** Audit log configuration. */
export interface AuditConfig {
  /** Path to the append-only JSONL audit log. */
  path: string;
}

/** Optional dashboard telemetry sink for decision traces. */
export interface DashboardConfig {
  /** Full URL of the kcp-dashboard /trace endpoint (e.g. http://localhost:7734/trace). */
  url?: string;
}

/** Top-level harness configuration. */
export interface HarnessConfig {
  version: string;
  governance: {
    domains: GovernedDomain[];
    policy: GovernancePolicy;
    /** Human-approval gates (absent = no approval rules). */
    approvals?: ApprovalsConfig;
    /** Confidence gate for harness_assess (absent = caller must supply a threshold). */
    confidence?: ConfidenceConfig;
  };
  downstream: DownstreamConfig[];
  audit: AuditConfig;
  /** Opt-in decision-trace telemetry sink (absent = disabled). */
  dashboard?: DashboardConfig;
}

/** Default governance policy. */
export const DEFAULT_POLICY: GovernancePolicy = {
  fail_closed: true,
  audit_all: true,
  max_units: 5,
  strict: false,
};

/** Default audit configuration. */
export const DEFAULT_AUDIT: AuditConfig = {
  path: ".kcp-harness/audit.jsonl",
};

/** Load and validate a harness configuration from a YAML file. */
export function loadConfig(path: string): HarnessConfig {
  const text = readFileSync(path, "utf-8");
  return parseConfig(text);
}

/** Parse a harness configuration from YAML text. */
export function parseConfig(text: string): HarnessConfig {
  const raw = yaml.load(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error("harness config must be a YAML object");

  const governance = raw["governance"] as Record<string, unknown> | undefined;
  const domains = parseDomains(governance?.["domains"]);
  const policy = parsePolicy(governance?.["policy"]);
  const approvals = parseApprovals(governance?.["approvals"]);
  const confidence = parseConfidence(governance?.["confidence"]);
  const downstream = parseDownstream(raw["downstream"]);
  const audit = parseAudit(raw["audit"]);
  const dashboard = parseDashboard(raw["dashboard"]);

  return {
    version: String(raw["version"] ?? "1.0"),
    governance: {
      domains,
      policy,
      ...(approvals ? { approvals } : {}),
      ...(confidence ? { confidence } : {}),
    },
    downstream,
    audit,
    ...(dashboard ? { dashboard } : {}),
  };
}

function parseDashboard(raw: unknown): DashboardConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  return { url: d["url"] === undefined ? undefined : String(d["url"]) };
}

function parseApprovals(raw: unknown): ApprovalsConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  const rules = Array.isArray(a["rules"]) ? a["rules"].map(parseApprovalRule) : [];
  return {
    provider: a["provider"] === "memory" ? "memory" : "file",
    dir: a["dir"] === undefined ? undefined : String(a["dir"]),
    rules,
    require_signed_resolutions: a["require_signed_resolutions"] === true,
    trusted_keys: Array.isArray(a["trusted_keys"]) ? a["trusted_keys"].map(String) : undefined,
  };
}

function parseApprovalRule(raw: Record<string, unknown>): ApprovalRule {
  const requiredRole = raw["required_role"];
  if (!requiredRole || typeof requiredRole !== "string") {
    throw new Error("approval rule requires required_role — an approval nobody is named to give cannot resolve");
  }
  const match = (raw["match"] ?? {}) as Record<string, unknown>;
  return {
    match: {
      tools: Array.isArray(match["tools"]) ? match["tools"].map(String) : undefined,
      paths: Array.isArray(match["paths"]) ? match["paths"].map(String) : undefined,
    },
    required_role: requiredRole,
    expires_after: raw["expires_after"] === undefined ? undefined : String(raw["expires_after"]),
    policy_ref: raw["policy_ref"] === undefined ? undefined : String(raw["policy_ref"]),
  };
}

function parseConfidence(raw: unknown): ConfidenceConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const threshold = Number(c["threshold"]);
  if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`confidence.threshold must be a number in 0..1, got ${String(c["threshold"])}`);
  }
  return {
    threshold,
    severity: c["severity"] === undefined ? undefined : String(c["severity"]),
    route_to_role: c["route_to_role"] === undefined ? undefined : String(c["route_to_role"]),
    expires_after: c["expires_after"] === undefined ? undefined : String(c["expires_after"]),
    policy_ref: c["policy_ref"] === undefined ? undefined : String(c["policy_ref"]),
  };
}

function parseDomains(raw: unknown): GovernedDomain[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((d: Record<string, unknown>) => ({
    manifest: String(d["manifest"] ?? ""),
    paths: Array.isArray(d["paths"]) ? d["paths"].map(String) : undefined,
    urls: Array.isArray(d["urls"]) ? d["urls"].map(String) : undefined,
    tools: Array.isArray(d["tools"]) ? d["tools"].map(String) : undefined,
  }));
}

function parsePolicy(raw: unknown): GovernancePolicy {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_POLICY };
  const p = raw as Record<string, unknown>;
  return {
    fail_closed: p["fail_closed"] !== false,
    audit_all: p["audit_all"] !== false,
    budget: parseBudget(p["budget"]),
    context_budget: p["context_budget"] === undefined ? undefined : Number(p["context_budget"]),
    max_units: p["max_units"] === undefined ? DEFAULT_POLICY.max_units : Number(p["max_units"]),
    strict: p["strict"] === true,
    env: p["env"] === undefined ? undefined : String(p["env"]),
    signature_required: p["signature_required"] === true,
    trusted_keys: Array.isArray(p["trusted_keys"]) ? p["trusted_keys"].map(String) : undefined,
  };
}

function parseBudget(raw: unknown): { amount: number; currency?: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  return {
    amount: Number(b["amount"] ?? 0),
    currency: b["currency"] === undefined ? undefined : String(b["currency"]),
  };
}

function parseDownstream(raw: unknown): DownstreamConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((d: Record<string, unknown>) => ({
    name: String(d["name"] ?? ""),
    command: String(d["command"] ?? ""),
    args: Array.isArray(d["args"]) ? d["args"].map(String) : undefined,
    env: d["env"] && typeof d["env"] === "object" ? Object.fromEntries(
      Object.entries(d["env"] as Record<string, unknown>).map(([k, v]) => [k, String(v)])
    ) : undefined,
  }));
}

function parseAudit(raw: unknown): AuditConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_AUDIT };
  const a = raw as Record<string, unknown>;
  return {
    path: String(a["path"] ?? DEFAULT_AUDIT.path),
  };
}

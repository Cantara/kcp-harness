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
  const downstream = parseDownstream(raw["downstream"]);
  const audit = parseAudit(raw["audit"]);
  const dashboard = parseDashboard(raw["dashboard"]);

  return {
    version: String(raw["version"] ?? "1.0"),
    governance: { domains, policy },
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

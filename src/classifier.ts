// Tool call classifier — detect knowledge-navigation tool calls.
//
// The classifier is a pure function: given a tool name, its arguments, and
// the configured governed domains, it returns whether the call targets a
// governed knowledge domain, which domain matched, and why.
//
// Classification happens BEFORE governance. Every tool call is classified
// exactly once; the governance layer only runs for governed calls.
//
// The classifier extracts the target path or URL from known tool argument
// shapes (Read, Glob, Grep, WebFetch, etc.) and matches against the
// governed domain's path/URL prefixes. Tool names in the domain's `tools`
// list are matched directly regardless of arguments.

import type { GovernedDomain } from "./config.js";

/** The result of classifying a tool call. */
export interface Classification {
  /** Whether this call targets a governed knowledge domain. */
  governed: boolean;
  /** Which governed domain matched (if any). */
  domain?: GovernedDomain;
  /** The path or URL that triggered the match. */
  target?: string;
  /** Human-readable reason for the classification. */
  reason: string;
}

// -- Path extraction from tool arguments -----------------------------------

/** Known tool argument shapes for extracting file paths. */
const PATH_EXTRACTORS: Record<string, (args: Record<string, unknown>) => string | undefined> = {
  // Claude Code built-in tools
  Read: (a) => str(a["file_path"]),
  Edit: (a) => str(a["file_path"]),
  Write: (a) => str(a["file_path"]),
  Glob: (a) => str(a["path"]) ?? extractPathPrefix(str(a["pattern"])),
  Grep: (a) => str(a["path"]),

  // MCP filesystem tools (common patterns)
  read_file: (a) => str(a["path"]),
  write_file: (a) => str(a["path"]),
  list_directory: (a) => str(a["path"]),
  search_files: (a) => str(a["path"]),
  get_file_info: (a) => str(a["path"]),

  // Bash — best-effort: check for file access patterns
  Bash: (a) => extractBashTarget(str(a["command"])),
};

/** Known tool argument shapes for extracting URLs. */
const URL_EXTRACTORS: Record<string, (args: Record<string, unknown>) => string | undefined> = {
  WebFetch: (a) => str(a["url"]),
  WebSearch: (a) => undefined, // search queries aren't URL targets
  fetch: (a) => str(a["url"]),
};

/** KCP tools are always classified as knowledge-nav. */
const KCP_TOOLS = new Set(["kcp_plan", "kcp_load", "kcp_trace", "kcp_validate", "kcp_replay"]);

// -- Classification ---------------------------------------------------------

/**
 * Classify a tool call: is it knowledge-navigation targeting a governed domain?
 *
 * Classification rules (in order):
 * 1. KCP tools → always governed (route to kcp-agent directly)
 * 2. Tool name in domain's `tools` list → governed by that domain
 * 3. File path extracted from arguments → match against domain paths
 * 4. URL extracted from arguments → match against domain URLs
 * 5. Otherwise → pass-through (ungoverned)
 */
export function classify(
  toolName: string,
  args: Record<string, unknown>,
  domains: GovernedDomain[],
): Classification {
  // Rule 1: KCP tools are always knowledge-nav
  if (KCP_TOOLS.has(toolName)) {
    return { governed: true, reason: `KCP tool: ${toolName}` };
  }

  // Rule 2: tool name explicitly listed in a domain
  for (const domain of domains) {
    if (domain.tools?.includes(toolName)) {
      return { governed: true, domain, reason: `tool ${toolName} is governed by ${domain.manifest}` };
    }
  }

  // Rule 3: extract path and match against governed path prefixes
  const pathExtractor = PATH_EXTRACTORS[toolName];
  if (pathExtractor) {
    const target = pathExtractor(args);
    if (target) {
      const normalized = normalizePath(target);
      for (const domain of domains) {
        if (domain.paths) {
          for (const prefix of domain.paths) {
            if (matchesPrefix(normalized, normalizePath(prefix))) {
              return {
                governed: true,
                domain,
                target: normalized,
                reason: `path ${normalized} is governed by ${domain.manifest} (prefix: ${prefix})`,
              };
            }
          }
        }
      }
    }
  }

  // Rule 4: extract URL and match against governed URL prefixes
  const urlExtractor = URL_EXTRACTORS[toolName];
  if (urlExtractor) {
    const target = urlExtractor(args);
    if (target) {
      for (const domain of domains) {
        if (domain.urls) {
          for (const prefix of domain.urls) {
            if (target.startsWith(prefix)) {
              return {
                governed: true,
                domain,
                target,
                reason: `URL ${target} is governed by ${domain.manifest} (prefix: ${prefix})`,
              };
            }
          }
        }
      }
    }
  }

  // Rule 5: pass-through
  return { governed: false, reason: `tool ${toolName} does not target a governed domain` };
}

/**
 * Extract known targets from any tool call arguments.
 * Useful for audit logging even when not governed.
 */
export function extractTargets(toolName: string, args: Record<string, unknown>): {
  paths: string[];
  urls: string[];
} {
  const paths: string[] = [];
  const urls: string[] = [];

  const pathFn = PATH_EXTRACTORS[toolName];
  if (pathFn) {
    const p = pathFn(args);
    if (p) paths.push(p);
  }

  const urlFn = URL_EXTRACTORS[toolName];
  if (urlFn) {
    const u = urlFn(args);
    if (u) urls.push(u);
  }

  return { paths, urls };
}

// -- Helpers ----------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Normalize a file path: strip leading ./ and trailing /, collapse //. */
export function normalizePath(p: string): string {
  let n = p.replace(/\/+/g, "/");
  if (n.startsWith("./")) n = n.slice(2);
  // Don't strip leading / — absolute paths stay absolute
  return n;
}

/** Check if a path starts with a prefix (directory-boundary-aware). */
export function matchesPrefix(path: string, prefix: string): boolean {
  // Normalize both: strip trailing slashes for comparison
  const a = path.replace(/\/+$/, "");
  const b = prefix.replace(/\/+$/, "");
  if (a === b) return true;
  // Ensure prefix matches at a directory boundary
  return a.startsWith(b + "/");
}

/** Extract the directory prefix from a glob pattern (best-effort). */
function extractPathPrefix(pattern: string | undefined): string | undefined {
  if (!pattern) return undefined;
  // Take everything before the first glob character
  const idx = pattern.search(/[*?\[{]/);
  if (idx <= 0) return undefined;
  const prefix = pattern.slice(0, idx);
  // Find the last / before the glob
  const lastSlash = prefix.lastIndexOf("/");
  if (lastSlash > 0) return prefix.slice(0, lastSlash);
  // If the prefix itself is a directory name (e.g. "src" from "src/**"), return it
  if (prefix.length > 0 && !prefix.includes(".")) return prefix.replace(/\/$/, "");
  return undefined;
}

/** Best-effort extraction of file paths from Bash commands. */
function extractBashTarget(command: string | undefined): string | undefined {
  if (!command) return undefined;
  // Match common file-access commands: cat, head, tail, less, more, vi, nano
  const fileCommands = /\b(?:cat|head|tail|less|more|vi|vim|nano|code)\s+["']?([^\s"'|;&]+)/;
  const m = command.match(fileCommands);
  return m?.[1] ?? undefined;
}

/**
 * Red-team tests — adversarial attack surface coverage for kcp-harness.
 *
 * Each test simulates a specific bypass technique an agent or malicious
 * input might use to evade governance. All should fail-closed.
 *
 * Attack categories:
 * 1. Classifier evasion — crafting tool calls that escape classification
 * 2. Path traversal — using ../ and symlinks to escape governed prefixes
 * 3. Tool aliasing — using unknown/renamed tools to access governed content
 * 4. Budget manipulation — circumventing spend limits
 * 5. Audit gaps — actions that don't produce audit events
 * 6. Session state manipulation — poisoning plans/known[]
 * 7. Injection via args — smuggling paths in unexpected arguments
 */

import { describe, it, expect } from "vitest";
import { classify, normalizePath, matchesPrefix } from "../src/classifier.js";
import { govern } from "../src/governor.js";
import { buildEvent, sanitizeArgs } from "../src/audit.js";
import { createSession, addPlan, isPathApproved, recordSpend } from "../src/session.js";
import { BudgetLedger } from "../src/budget-ledger.js";
import { HarnessProxy, type ProxyOptions } from "../src/proxy.js";
import { InMemoryAuditLog } from "../src/audit.js";
import type { GovernedDomain, HarnessConfig, GovernancePolicy } from "../src/config.js";

// -- Test fixtures ----------------------------------------------------------

const GOVERNED_DOMAIN: GovernedDomain = {
  manifest: "./knowledge.yaml",
  paths: ["docs/", "src/models/", "secrets/"],
  urls: ["https://docs.example.com/"],
};

const DOMAINS = [GOVERNED_DOMAIN];

const STRICT_POLICY: GovernancePolicy = {
  fail_closed: true,
  audit_all: true,
  max_units: 5,
  strict: false,
};

function makeProxy(auditLog: InMemoryAuditLog): HarnessProxy {
  const config: HarnessConfig = {
    governance: {
      domains: [GOVERNED_DOMAIN],
      policy: STRICT_POLICY,
    },
    downstream: [],
    audit: { path: ":memory:" },
  };
  return new HarnessProxy({ config, audit: auditLog });
}

// ===========================================================================
// 1. CLASSIFIER EVASION
// ===========================================================================

describe("RED: classifier evasion", () => {
  it("path traversal via ../ is resolved and caught", () => {
    // Attack: Read("other/../docs/secret.md") — normalizes to docs/secret.md
    const result = classify("Read", { file_path: "other/../docs/secret.md" }, DOMAINS);
    // FIXED: normalizePath now resolves ../
    expect(result.governed).toBe(true);
  });

  it("double-slash bypass: docs//secret.md", () => {
    const result = classify("Read", { file_path: "docs//secret.md" }, DOMAINS);
    expect(result.governed).toBe(true); // normalizePath collapses //
  });

  it("leading ./ bypass: ./docs/secret.md", () => {
    const result = classify("Read", { file_path: "./docs/secret.md" }, DOMAINS);
    expect(result.governed).toBe(true); // normalizePath strips ./
  });

  it("absolute path bypass: /home/user/project/docs/secret.md", () => {
    // Attack: use absolute path — governed prefixes are relative
    const result = classify(
      "Read",
      { file_path: "/home/user/project/docs/secret.md" },
      DOMAINS,
    );
    // FINDING: absolute paths bypass relative prefix matching
    expect(result.governed).toBe(false); // BUG: should be true if cwd-relative
  });

  it("case variation bypass: Docs/secret.md (Linux is case-sensitive, but...)", () => {
    const result = classify("Read", { file_path: "Docs/secret.md" }, DOMAINS);
    // On case-sensitive filesystems, "Docs/" != "docs/" — correct behavior
    expect(result.governed).toBe(false);
  });

  it("unicode normalization bypass: docs\u200B/secret.md (zero-width space)", () => {
    // Attack: insert zero-width characters that get stripped by the filesystem
    const result = classify("Read", { file_path: "docs\u200B/secret.md" }, DOMAINS);
    // FINDING: unicode chars are not stripped — they'd fail on the filesystem too, so this is OK
    expect(result.governed).toBe(false); // acceptable: the file doesn't exist with ZWS
  });

  it("Bash cat bypass: cat docs/secret.md", () => {
    const result = classify("Bash", { command: "cat docs/secret.md" }, DOMAINS);
    expect(result.governed).toBe(true); // extractBashTarget matches cat
  });

  it("Bash less bypass: less docs/secret.md", () => {
    const result = classify("Bash", { command: "less docs/secret.md" }, DOMAINS);
    expect(result.governed).toBe(true); // extractBashTarget matches less
  });

  it("Bash cp is now caught", () => {
    const result = classify("Bash", { command: "cp docs/secret.md /tmp/exfil.txt" }, DOMAINS);
    // FIXED: cp is now in extractBashTarget
    expect(result.governed).toBe(true);
  });

  it("Bash python open() is now caught", () => {
    const result = classify(
      "Bash",
      { command: 'python3 -c \'open("docs/secret.md").read()\'' },
      DOMAINS,
    );
    // FIXED: open("path") pattern is now matched
    expect(result.governed).toBe(true);
  });

  it("Bash redirect is now caught", () => {
    const result = classify("Bash", { command: "echo attack > docs/overwrite.md" }, DOMAINS);
    // FIXED: redirect targets are now matched
    expect(result.governed).toBe(true);
  });

  it("Bash curl file:// bypass: curl file:///home/user/project/docs/secret.md", () => {
    const result = classify(
      "Bash",
      { command: "curl file:///home/user/project/docs/secret.md" },
      DOMAINS,
    );
    expect(result.governed).toBe(false); // BUG: file:// protocol bypass
  });

  it("unknown tool bypass: custom_read with file_path", () => {
    // Attack: use a tool the classifier doesn't know about
    const result = classify("custom_read", { file_path: "docs/secret.md" }, DOMAINS);
    // FINDING: unknown tools are pass-through by default
    expect(result.governed).toBe(false); // by design — but a risk if downstream has custom tools
  });

  it("Grep without path (searches cwd — could hit governed content)", () => {
    // Attack: Grep without specifying a path searches everything
    const result = classify("Grep", { pattern: "password" }, DOMAINS);
    // FINDING: No path extracted → pass-through, but Grep will search governed dirs
    expect(result.governed).toBe(false); // BUG: Grep with no path hits everything
  });

  it("Glob with pattern rooted in governed dir", () => {
    const result = classify("Glob", { pattern: "docs/**/*.md" }, DOMAINS);
    expect(result.governed).toBe(true); // extractPathPrefix catches "docs"
  });

  it("Glob with pattern using brace expansion to include governed path", () => {
    // Attack: {ungoverned,docs}/**/*.md — the prefix extractor might not catch "docs"
    const result = classify("Glob", { pattern: "{config,docs}/**/*.md" }, DOMAINS);
    // FINDING: brace expansion stops prefix extraction at {
    expect(result.governed).toBe(false); // BUG: brace expansion can include governed paths
  });

  it("WebFetch URL with fragment/query to evade prefix", () => {
    // Attack: add fragment to change apparent URL
    const result = classify(
      "WebFetch",
      { url: "https://docs.example.com/secret#bypass" },
      DOMAINS,
    );
    expect(result.governed).toBe(true); // startsWith still works
  });

  it("WebFetch with URL encoding to evade prefix: https://docs.example.com%2Fsecret", () => {
    // Attack: URL-encode the path separator
    const result = classify(
      "WebFetch",
      { url: "https://docs.example.com%2Fsecret" },
      DOMAINS,
    );
    // FINDING: the encoded URL doesn't startsWith the prefix
    expect(result.governed).toBe(false); // BUG: URL encoding bypass
  });
});

// ===========================================================================
// 2. PATH TRAVERSAL ATTACKS
// ===========================================================================

describe("RED: path traversal", () => {
  it("matchesPrefix with ../ traversal — resolved", () => {
    // normalizePath now resolves ../, so this matches correctly
    expect(matchesPrefix(normalizePath("other/../docs/file.md"), "docs")).toBe(true);
  });

  it("normalizePath resolves ../", () => {
    // FIXED: normalizePath now resolves ../
    expect(normalizePath("other/../docs/file.md")).toBe("docs/file.md");
    expect(normalizePath("a/b/../c/d")).toBe("a/c/d");
    expect(normalizePath("a/b/../../c")).toBe("c");
    expect(normalizePath("../outside")).toBe("outside"); // leading ../ stripped (can't go above cwd)
  });

  it("symlink attack: governed -> ungoverned via symlink", () => {
    // Attack: create a symlink from ungoverned/ -> docs/
    // Then Read("ungoverned/secret.md") bypasses the classifier
    // This is an OS-level attack the classifier can't prevent
    // without statting the path — noted as a known limitation
    const result = classify("Read", { file_path: "ungoverned/via-symlink.md" }, DOMAINS);
    expect(result.governed).toBe(false); // Expected: can't defend without stat()
  });
});

// ===========================================================================
// 3. BUDGET MANIPULATION
// ===========================================================================

describe("RED: budget manipulation", () => {
  it("negative spend to refund budget — BLOCKED", () => {
    const ledger = new BudgetLedger({ amount: 1.0, currency: "USDC" });
    ledger.record(
      { manifest: "m", task: "t" },
      { amount: 0.80, currency: "USDC", method: "free" },
    );
    // Attack: negative amount to reclaim budget
    const refund = ledger.record(
      { manifest: "m", task: "t" },
      { amount: -0.50, currency: "USDC", method: "refund" },
    );
    // FIXED: negative amounts are rejected
    expect(refund.accepted).toBe(false);
    expect(ledger.getTotal("USDC")).toBe(0.80); // Budget unchanged
  });

  it("different currency bypass: spend in EUR when ceiling is USDC", () => {
    const ledger = new BudgetLedger({ amount: 1.0, currency: "USDC" });
    // Attack: record spend in a different currency — no ceiling enforced
    const result = ledger.record(
      { manifest: "m", task: "t" },
      { amount: 999, currency: "EUR", method: "x402" },
    );
    // FINDING: ceiling only checked for matching currency
    expect(result.accepted).toBe(true); // by design, but allows unlimited non-ceiling currency spend
  });

  it("floating point overflow: 0.1 + 0.2 precision", () => {
    const ledger = new BudgetLedger({ amount: 1.0, currency: "USDC" });
    // Record many small amounts to test floating point accumulation
    for (let i = 0; i < 10; i++) {
      ledger.record(
        { manifest: "m", task: "t" },
        { amount: 0.1, currency: "USDC", method: "free" },
      );
    }
    // Should be exactly 1.0, not 0.9999999... or 1.0000001...
    expect(ledger.getTotal("USDC")).toBe(1.0);
    // The ceiling check should block the next spend
    const result = ledger.record(
      { manifest: "m", task: "t" },
      { amount: 0.01, currency: "USDC", method: "free" },
    );
    expect(result.accepted).toBe(false);
  });

  it("concurrent session state mutation (race condition)", () => {
    // In a single-threaded Node.js, this is less of an issue, but
    // if the proxy ever goes async between budget check and record...
    const session = createSession({ amount: 1.0, currency: "USDC" });
    // Record two spends that individually fit but together don't
    const r1 = session.ledger.record(
      { manifest: "m", task: "t1" },
      { amount: 0.60, currency: "USDC", method: "free" },
    );
    const r2 = session.ledger.record(
      { manifest: "m", task: "t2" },
      { amount: 0.60, currency: "USDC", method: "free" },
    );
    // First should succeed, second should fail
    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(false);
  });
});

// ===========================================================================
// 4. AUDIT GAPS
// ===========================================================================

describe("RED: audit gaps", () => {
  it("sanitizeArgs redacts Write content", () => {
    const args = { file_path: "docs/secret.md", content: "SECRET_API_KEY=sk-1234" };
    const sanitized = sanitizeArgs("Write", args);
    expect(sanitized["content"]).not.toContain("SECRET_API_KEY");
  });

  it("sanitizeArgs redacts Bash secrets", () => {
    const args = { command: "export API_KEY=sk-secret-value-1234" };
    const sanitized = sanitizeArgs("Bash", args);
    expect(String(sanitized["command"])).not.toContain("sk-secret-value-1234");
  });

  it("sanitizeArgs does NOT redact secrets in non-Bash tools", () => {
    // Attack: pass secret in Read args (unusual but possible)
    const args = { file_path: "docs/file.md", note: "password=hunter2" };
    const sanitized = sanitizeArgs("Read", args);
    // FINDING: only Write and Bash get redaction
    expect(String(sanitized["note"])).toContain("password=hunter2");
    // Low risk: Read args don't typically contain secrets, but custom tools might
  });

  it("sanitizeArgs Bash: multi-line command with secret on second line", () => {
    const args = {
      command: "echo hello\nexport SECRET_TOKEN=my-super-secret\ncat docs/file.md",
    };
    const sanitized = sanitizeArgs("Bash", args);
    expect(String(sanitized["command"])).not.toContain("my-super-secret");
  });

  it("sanitizeArgs Bash: secret in single quotes", () => {
    const args = { command: "curl -H 'Authorization: token ghp_secret123' https://api.github.com" };
    const sanitized = sanitizeArgs("Bash", args);
    // FINDING: the regex only matches key=value patterns, not header patterns
    expect(String(sanitized["command"])).toContain("ghp_secret123");
    // BUG: Authorization header tokens not redacted
  });
});

// ===========================================================================
// 5. SESSION STATE ATTACKS
// ===========================================================================

describe("RED: session state", () => {
  it("plan caching: old plan covers new content added after planning", () => {
    // Attack: plan is approved, then new sensitive files are added to the
    // governed directory. The cached plan still says "approved" for the prefix.
    const session = createSession();
    const fakePlan = {
      selected: [
        { id: "unit-a", path: "docs/api.md", score: 5, loadEligible: true, reasons: [] },
      ],
      skipped: [],
      budget: undefined as any,
      trust: undefined as any,
      federation: undefined as any,
    };
    addPlan(session, "./knowledge.yaml", "read the api", fakePlan as any);

    // The plan covers docs/api.md — but does it cover docs/NEW-sensitive.md?
    const approved = isPathApproved(session, "docs/NEW-sensitive.md");
    // CORRECT: the plan only covers specific units, not the entire prefix
    expect(approved).toBeUndefined(); // New paths require re-planning
  });

  it("known[] poisoning: record a fake sha256 to skip dedup check", () => {
    // Attack: if an agent can call recordLoaded with arbitrary values,
    // it could poison the known set to skip loading checks later.
    // This is only possible if the agent has access to the session API directly.
    // Through MCP, the agent can't call recordLoaded — it's internal.
    // This is a defense-in-depth note, not a vulnerability.
    const session = createSession();
    session.known.set("sensitive-unit", "fake-sha256");
    // The agent would need to be the harness process itself to do this
    expect(session.known.has("sensitive-unit")).toBe(true);
  });
});

// ===========================================================================
// 6. PROXY-LEVEL ATTACKS
// ===========================================================================

describe("RED: proxy-level", () => {
  it("tools/call with empty name", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = makeProxy(audit);
    const response = await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "", arguments: {} },
    });
    // Should not crash — empty tool name should be handled gracefully
    expect(response).toBeDefined();
  });

  it("tools/call with null arguments", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = makeProxy(audit);
    const response = await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "Read", arguments: null },
    });
    expect(response).toBeDefined();
  });

  it("tools/call with no params at all", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = makeProxy(audit);
    const response = await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
    });
    expect(response).toBeDefined();
  });

  it("unknown JSON-RPC method with id", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = makeProxy(audit);
    const response = await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "dangerous/admin/reset",
    });
    // Should return method-not-found error, not crash
    expect(response).toBeDefined();
    expect((response as any).error?.code).toBe(-32601);
  });

  it("method injection via params: params.name = '__proto__' (no crash)", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = makeProxy(audit);
    const response = await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "__proto__", arguments: {} },
    });
    // FIXED: Object.hasOwn prevents prototype lookup in PATH_EXTRACTORS
    expect(response).toBeDefined();
    // Should not crash — should return gracefully (error or pass-through)
  });

  it("oversized arguments don't crash", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = makeProxy(audit);
    const bigString = "A".repeat(10_000_000); // 10 MB
    const response = await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "Read", arguments: { file_path: bigString } },
    });
    expect(response).toBeDefined();
  });

  it("every governed tool call produces an audit event", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = makeProxy(audit);
    await proxy.start();

    // Call a governed tool
    await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "Read", arguments: { file_path: "docs/secret.md" } },
    });

    // Must have at least session_start + the tool_call
    const toolCallEvents = audit.events.filter((e) => e.type === "tool_call");
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolCallEvents[0].toolCall?.name).toBe("Read");
    expect(toolCallEvents[0].classification?.governed).toBe(true);

    await proxy.stop();
  });

  it("pass-through calls are audited when audit_all is true", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = makeProxy(audit);
    await proxy.start();

    // Call an ungoverned tool — it will error because no downstream handles it,
    // but the audit event must still be emitted
    await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "Read", arguments: { file_path: "package.json" } },
    });

    const toolCallEvents = audit.events.filter((e) => e.type === "tool_call");
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
    // Should be logged — either as pass-through or error (no downstream configured)
    const ptEvent = toolCallEvents.find(
      (e) => e.toolCall?.args?.["file_path"] === "package.json",
    );
    expect(ptEvent).toBeDefined();
    // No downstream to handle Read, so it errors — but it IS audited
    expect(ptEvent!.classification?.governed).toBe(false);

    await proxy.stop();
  });
});

// ===========================================================================
// SUMMARY: Findings that need fixing
// ===========================================================================

describe("RED: findings summary", () => {
  it("FIXED-001: ../ path traversal now caught", () => {
    const result = classify("Read", { file_path: "other/../docs/secret.md" }, DOMAINS);
    expect(result.governed).toBe(true);
  });

  it("KNOWN-002: absolute paths bypass relative prefix matching", () => {
    // Known limitation: absolute paths don't match relative prefixes.
    // Fix requires cwd context which the classifier doesn't have.
    // Mitigation: governed domains should also list absolute prefixes if needed.
    const result = classify(
      "Read",
      { file_path: "/home/user/project/docs/secret.md" },
      DOMAINS,
    );
    expect(result.governed).toBe(false); // accepted limitation
  });

  it("FIXED-003: Bash cp/mv/ln now caught", () => {
    const cmds = [
      "cp docs/secret.md /tmp/exfil.txt",
      "mv docs/secret.md /tmp/",
      "ln -s docs/secret.md /tmp/link",
    ];
    for (const cmd of cmds) {
      const result = classify("Bash", { command: cmd }, DOMAINS);
      expect(result.governed).toBe(true);
    }
  });

  it("KNOWN-003b: tar/zip with positional args are harder to parse", () => {
    // tar's flags aren't prefixed with -, and zip's first arg is the output
    // Best-effort regex doesn't catch these cases
    expect(classify("Bash", { command: "tar czf /tmp/exfil.tar.gz docs/" }, DOMAINS).governed).toBe(false);
    expect(classify("Bash", { command: "zip /tmp/exfil.zip docs/secret.md" }, DOMAINS).governed).toBe(false);
    // Mitigation: PreToolUse hooks or strict Bash blocking
  });

  it("FIXED-004: negative budget amounts rejected", () => {
    const ledger = new BudgetLedger({ amount: 1.0, currency: "USDC" });
    ledger.record({ manifest: "m", task: "t" }, { amount: 0.80, currency: "USDC", method: "free" });
    const refund = ledger.record(
      { manifest: "m", task: "t" },
      { amount: -0.50, currency: "USDC", method: "refund" },
    );
    expect(refund.accepted).toBe(false);
    expect(refund.reason).toContain("negative");
  });

  it("KNOWN-005: Grep without path searches governed content undetected", () => {
    // Known limitation: Grep without path is a wildcard search.
    // Mitigation: in strict mode, pathless Grep could be blocked.
    const result = classify("Grep", { pattern: "password" }, DOMAINS);
    expect(result.governed).toBe(false); // accepted limitation
  });

  it("KNOWN-006: glob brace expansion can include governed paths", () => {
    // Known limitation: brace expansion in globs prevents simple prefix extraction.
    // Mitigation: the auto-plan fallback would still block governed file reads.
    const result = classify("Glob", { pattern: "{config,docs}/**/*.md" }, DOMAINS);
    expect(result.governed).toBe(false); // accepted limitation
  });
});

// Approval grants — an approval is the scope of ONE human decision, never a standing permission.
// once / session / duration, capped by grant_max; bound to session, tool, target and arguments.

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { govern, type ApprovalContext } from "../src/governor.js";
import type { Classification } from "../src/classifier.js";
import { createSession, type SessionState } from "../src/session.js";
import { parseConfig, type GovernancePolicy, type ApprovalRule } from "../src/config.js";
import {
  FileApprovalProvider,
  InMemoryApprovalProvider,
  newRequest,
  argsDigest,
  type ApprovalProvider,
  type ApprovalRequest,
} from "../src/approval.js";
import { HarnessProxy } from "../src/proxy.js";
import { InMemoryAuditLog } from "../src/audit.js";
import { runApprovals } from "../src/approvals-cli.js";

const policy: GovernancePolicy = { fail_closed: true, audit_all: true, max_units: 5, strict: false };
const TARGET = "records/customer-7.md";
const H = 3600_000;

function rule(grant?: string): ApprovalRule {
  return {
    match: { tools: ["Write"], paths: ["records/"] },
    required_role: "account-owner",
    policy_ref: "POL-7.2",
    ...(grant ? { grant } : {}),
  };
}

function cls(): Classification {
  return {
    governed: true,
    reason: "governed",
    domain: { manifest: "./no-such-knowledge.yaml", paths: ["records/"] },
    target: TARGET,
  } as Classification;
}

function ctx(r: ApprovalRule, provider: ApprovalProvider = new InMemoryApprovalProvider(), grantMax?: string): ApprovalContext {
  return { provider, rules: [r], ...(grantMax ? { grantMax } : {}) };
}

const ARGS = { file_path: TARGET, content: "x" };
const call = (c: ApprovalContext, s: SessionState, args: Record<string, unknown> = ARGS, corr?: string) =>
  govern(cls(), "Write", args, s, policy, c, undefined, corr);

/** Open a ticket through the governor, then approve it `agoMs` in the past. */
async function approveOpened(c: ApprovalContext, s: SessionState, agoMs = 0) {
  const d = await call(c, s);
  expect(d.mode).toBe("pending");
  await c.provider.resolve({
    id: d.pendingId!, state: "approved", reviewer: "Kari N.",
    reviewedAt: new Date(Date.now() - agoMs).toISOString(), policyRef: "POL-7.2",
  });
  return d.pendingId!;
}

/** Seed a legacy ticket (no grant / argsDigest metadata), as written before this change. */
async function seedLegacy(p: ApprovalProvider, sessionId: string, agoMs: number, state: "approved" | "dismissed" = "approved") {
  const req = newRequest({ sessionId, toolName: "Write", target: TARGET, task: "t", requiredRole: "account-owner", evidence: {} });
  await p.submit(req);
  await p.resolve({ id: req.id, state, reviewer: "Kari N.", reviewedAt: new Date(Date.now() - agoMs).toISOString(), policyRef: "POL-7.2" });
  return req;
}

describe("grant: session (default)", () => {
  it("approved ticket authorises the opening session", async () => {
    const c = ctx(rule());
    const s = createSession();
    await approveOpened(c, s);
    const d = await call(c, s);
    expect(d.approved).toBe(true);
    expect(d.mode).toBe("human-approved");
  });

  it("another session is NOT approved: wrong_session, and a new ticket opens", async () => {
    const c = ctx(rule());
    const a = createSession();
    const b = createSession();
    const ticketA = await approveOpened(c, a);
    const d = await call(c, b);
    expect(d.approved).toBe(false);
    expect(d.mode).toBe("pending");
    expect(d.submitted).toBe(true);
    expect(d.grantDenied).toEqual({ reason: "wrong_session", ticketId: ticketA });
    expect(d.pendingId).not.toBe(ticketA);
    // session A is unaffected
    expect((await call(c, a)).approved).toBe(true);
  });

  it("a pending ticket of another session is not reused", async () => {
    const c = ctx(rule());
    const a = createSession();
    const b = createSession();
    const first = await call(c, a);
    const second = await call(c, b);
    expect(second.pendingId).not.toBe(first.pendingId);
    expect(second.submitted).toBe(true);
  });

  it("default hard maximum is 24h: an approval 25h old is expired", async () => {
    const c = ctx(rule());
    const s = createSession();
    const id = await approveOpened(c, s, 25 * H);
    const d = await call(c, s);
    expect(d.approved).toBe(false);
    expect(d.grantDenied).toEqual({ reason: "expired", ticketId: id });
    expect(d.mode).toBe("pending");
  });

  it("an approval 23h old is still valid", async () => {
    const c = ctx(rule());
    const s = createSession();
    await approveOpened(c, s, 23 * H);
    expect((await call(c, s)).approved).toBe(true);
  });
});

describe("grant: duration and grant_max", () => {
  it("valid inside the duration, expired after it", async () => {
    const c = ctx(rule("15m"));
    const s = createSession();
    await approveOpened(c, s, 10 * 60_000);
    expect((await call(c, s)).approved).toBe(true);

    const c2 = ctx(rule("15m"));
    const s2 = createSession();
    const id = await approveOpened(c2, s2, 16 * 60_000);
    const d = await call(c2, s2);
    expect(d.approved).toBe(false);
    expect(d.grantDenied).toEqual({ reason: "expired", ticketId: id });
  });

  it("the duration is stamped on the ticket", async () => {
    const c = ctx(rule("4h"));
    const d = await call(c, createSession());
    const t = await c.provider.check(d.pendingId!);
    expect(t?.request.grant).toEqual({ mode: "duration", durationMs: 4 * H });
  });

  it("grant_max caps a longer rule duration", async () => {
    const c = ctx(rule("1d"), undefined, "1h");
    const s = createSession();
    await approveOpened(c, s, 2 * H);
    const d = await call(c, s);
    expect(d.approved).toBe(false);
    expect(d.grantDenied?.reason).toBe("expired");
  });

  it("grant_max caps session grants too", async () => {
    const c = ctx(rule("session"), undefined, "30m");
    const s = createSession();
    await approveOpened(c, s, 31 * 60_000);
    expect((await call(c, s)).grantDenied?.reason).toBe("expired");
  });

  it("an invalid grant_max fails closed (blocked), never widens", async () => {
    const c = ctx(rule(), undefined, "forever");
    const d = await call(c, createSession());
    expect(d.approved).toBe(false);
    expect(d.mode).toBe("blocked");
  });
});

describe("grant: once", () => {
  it("is consumed by the first matching call; the next call re-opens a new ticket", async () => {
    const c = ctx(rule("once"));
    const s = createSession();
    const id = await approveOpened(c, s);

    const first = await call(c, s, ARGS, "corr-1");
    expect(first.approved).toBe(true);
    expect(first.reason).toContain("grant once");

    const second = await call(c, s, ARGS, "corr-2");
    expect(second.approved).toBe(false);
    expect(second.mode).toBe("pending");
    expect(second.submitted).toBe(true);
    expect(second.grantDenied).toEqual({ reason: "used", ticketId: id });

    const used = await c.provider.check(id);
    expect(used?.state).toBe("used");
    expect(used?.use?.correlationId).toBe("corr-1");
    expect(used?.use?.sessionId).toBe(s.id);
    expect(await c.provider.list({ state: "used" })).toHaveLength(1);
  });

  it("concurrent calls on a once grant: exactly one succeeds (memory)", async () => {
    const c = ctx(rule("once"));
    const s = createSession();
    await approveOpened(c, s);
    const results = await Promise.all(Array.from({ length: 10 }, () => call(c, s)));
    expect(results.filter((d) => d.approved)).toHaveLength(1);
  });

  it("concurrent calls on a once grant: exactly one succeeds (file store)", async () => {
    const c = ctx(rule("once"), new FileApprovalProvider(mkdtempSync(join(tmpdir(), "grant-"))));
    const s = createSession();
    await approveOpened(c, s);
    const results = await Promise.all(Array.from({ length: 10 }, () => call(c, s)));
    expect(results.filter((d) => d.approved)).toHaveLength(1);
  });

  it("two independent file-provider instances (two processes' view) cannot both consume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grant-"));
    const p1 = new FileApprovalProvider(dir);
    const p2 = new FileApprovalProvider(dir);
    const c1 = ctx(rule("once"), p1);
    const s = createSession();
    const id = await approveOpened(c1, s);
    const wins = await Promise.all([
      p1.consume({ id, sessionId: s.id }),
      p2.consume({ id, sessionId: s.id }),
    ]);
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect((await p2.check(id))?.state).toBe("used");
  });

  it("a provider that cannot consume fails closed for once grants", async () => {
    const mem = new InMemoryApprovalProvider();
    const noConsume: ApprovalProvider = {
      submit: (r) => mem.submit(r), check: (i) => mem.check(i), resolve: (r) => mem.resolve(r), list: (f) => mem.list(f),
    };
    const c = ctx(rule("once"), noConsume);
    const s = createSession();
    await approveOpened(c, s);
    const d = await call(c, s);
    expect(d.approved).toBe(false);
    expect(d.grantDenied?.reason).toBe("invalid");
  });

  it("an unconsumed once grant still lapses at grant_max", async () => {
    const c = ctx(rule("once"));
    const s = createSession();
    await approveOpened(c, s, 25 * H);
    expect((await call(c, s)).grantDenied?.reason).toBe("expired");
  });
});

describe("argument binding", () => {
  it("an approval for one set of arguments does not cover different arguments", async () => {
    const c = ctx(rule());
    const s = createSession();
    await approveOpened(c, s);
    const d = await call(c, s, { file_path: TARGET, content: "something else entirely" });
    expect(d.approved).toBe(false);
    expect(d.mode).toBe("pending");
    expect(d.submitted).toBe(true);
  });

  it("the digest ignores correlation carriers and key order", () => {
    const a = argsDigest({ x: 1, y: 2, traceparent: "00-aa-bb-01", _meta: { progressToken: 1 } });
    const b = argsDigest({ y: 2, x: 1 });
    expect(a).toBe(b);
    expect(argsDigest({ x: 1 })).not.toBe(argsDigest({ x: 2 }));
  });
});

describe("ordering of tickets for one (tool, target)", () => {
  it("a newer dismissal beats an older approval", async () => {
    const c = ctx(rule());
    const s = createSession();
    await approveOpened(c, s);
    const second = newRequest({ sessionId: s.id, toolName: "Write", target: TARGET, task: "t", requiredRole: "r", argsDigest: argsDigest(ARGS), evidence: {} });
    await c.provider.submit(second);
    await c.provider.resolve({ id: second.id, state: "dismissed", reviewer: "Kari N.", reviewedAt: new Date().toISOString(), policyRef: "POL-7.2" });
    const d = await call(c, s);
    expect(d.approved).toBe(false);
    expect(d.mode).toBe("blocked");
  });

  it("a newer valid approval beats an older dismissal", async () => {
    const c = ctx(rule());
    const s = createSession();
    const first = newRequest({ sessionId: s.id, toolName: "Write", target: TARGET, task: "t", requiredRole: "r", argsDigest: argsDigest(ARGS), evidence: {} });
    await c.provider.submit(first);
    await c.provider.resolve({ id: first.id, state: "dismissed", reviewer: "Kari N.", reviewedAt: new Date().toISOString(), policyRef: "POL-7.2" });
    const second = newRequest({ sessionId: s.id, toolName: "Write", target: TARGET, task: "t", requiredRole: "r", argsDigest: argsDigest(ARGS), evidence: {} });
    await c.provider.submit(second);
    await c.provider.resolve({ id: second.id, state: "approved", reviewer: "Kari N.", reviewedAt: new Date().toISOString(), policyRef: "POL-7.2" });
    expect((await call(c, s)).approved).toBe(true);
  });

  it("an older valid approval does not bypass a newer pending ticket", async () => {
    const c = ctx(rule());
    const s = createSession();
    await approveOpened(c, s);
    const pending = newRequest({ sessionId: s.id, toolName: "Write", target: TARGET, task: "t", requiredRole: "r", argsDigest: argsDigest(ARGS), evidence: {} });
    await c.provider.submit(pending);
    const d = await call(c, s);
    expect(d.approved).toBe(false);
    expect(d.mode).toBe("pending");
    expect(d.pendingId).toBe(pending.id);
  });

  it("a newer EXPIRED (TTL) ticket does not let an older approval through", async () => {
    const c = ctx(rule());
    const s = createSession();
    await approveOpened(c, s);
    const stale = newRequest({ sessionId: s.id, toolName: "Write", target: TARGET, task: "t", requiredRole: "r", argsDigest: argsDigest(ARGS), expiresAt: new Date(Date.now() - 1000).toISOString(), evidence: {} });
    await c.provider.submit(stale);
    const d = await call(c, s);
    expect(d.approved).toBe(false);
    expect(d.submitted).toBe(true);
  });

  it("a dismissal in another session does not block this session", async () => {
    const c = ctx(rule());
    await seedLegacy(c.provider, "other-session", 0, "dismissed");
    const d = await call(c, createSession());
    expect(d.mode).toBe("pending");
    expect(d.submitted).toBe(true);
  });
});

describe("legacy tickets (no grant metadata)", () => {
  it("are session-scoped by request.sessionId", async () => {
    const c = ctx(rule());
    const s = createSession();
    await seedLegacy(c.provider, s.id, 1 * H);
    expect((await call(c, s)).approved).toBe(true);
    const other = await call(c, createSession());
    expect(other.approved).toBe(false);
    expect(other.grantDenied?.reason).toBe("wrong_session");
  });

  it("expire at resolvedAt + grant_max (24h default)", async () => {
    const c = ctx(rule());
    const s = createSession();
    await seedLegacy(c.provider, s.id, 25 * H);
    const d = await call(c, s);
    expect(d.approved).toBe(false);
    expect(d.grantDenied?.reason).toBe("expired");
  });

  it("are not bound to arguments (documented limit of migrated tickets)", async () => {
    const c = ctx(rule());
    const s = createSession();
    await seedLegacy(c.provider, s.id, 0);
    expect((await call(c, s, { other: "args" })).approved).toBe(true);
  });

  it("a legacy log line without grant fields parses from the file store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grant-"));
    const s = createSession();
    const line1 = { kind: "request", request: { id: "legacy-1", sessionId: s.id, toolName: "Write", target: TARGET, task: "t", requiredRole: "r", requestedAt: new Date().toISOString(), evidence: {} } };
    const line2 = { kind: "resolution", resolution: { id: "legacy-1", state: "approved", reviewer: "Kari N.", reviewedAt: new Date().toISOString(), policyRef: "POL-7.2" } };
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "approvals.jsonl"), JSON.stringify(line1) + "\n" + JSON.stringify(line2) + "\n");
    const c = ctx(rule(), new FileApprovalProvider(dir));
    expect((await call(c, s)).approved).toBe(true);
  });
});

describe("fail-closed", () => {
  it("unreadable store (a directory where the file should be) blocks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grant-"));
    const provider = new FileApprovalProvider(dir);
    mkdirSync(provider.getPath()); // approvals.jsonl is now a directory → read throws EISDIR
    const d = await call(ctx(rule(), provider), createSession());
    expect(d.approved).toBe(false);
    expect(d.mode).toBe("blocked");
    expect(d.reason).toContain("fail-closed");
  });

  it("a torn / corrupt line is skipped and never turns into an approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grant-"));
    const provider = new FileApprovalProvider(dir);
    appendFileSync(provider.getPath(), '{"kind":"resolution","resolution":{"id":"x","state":"appr\n{not json\n');
    const d = await call(ctx(rule(), provider), createSession());
    expect(d.approved).toBe(false);
    expect(d.mode).toBe("pending");
  });

  it("an approved ticket with an unparseable reviewedAt is not honoured", async () => {
    const c = ctx(rule());
    const s = createSession();
    const req = await seedLegacy(c.provider, s.id, 0);
    const mem = c.provider as InMemoryApprovalProvider;
    // corrupt the stored resolution in place
    const status = await mem.check(req.id);
    status!.resolution!.reviewedAt = "not-a-date";
    const d = await call(c, s);
    expect(d.approved).toBe(false);
    expect(d.grantDenied?.reason).toBe("invalid");
  });

  it("an approved ticket with an unknown grant mode is not honoured", async () => {
    const c = ctx(rule());
    const s = createSession();
    const req = await seedLegacy(c.provider, s.id, 0);
    (req as ApprovalRequest).grant = { mode: "forever" as never };
    expect((await call(c, s)).approved).toBe(false);
  });

  it("a missing sessionId is never approved", async () => {
    const c = ctx(rule());
    await seedLegacy(c.provider, "", 0);
    const noSession = { ...createSession(), id: "" };
    const d = await call(c, noSession);
    expect(d.approved).toBe(false);
    expect(d.mode).toBe("blocked");
    expect(d.grantDenied?.reason).toBe("invalid");
  });
});

describe("config", () => {
  const base = (extra: string, grant = "") => `
version: "1.0"
governance:
  domains: [{ manifest: ./k.yaml, paths: [records/] }]
  approvals:
    provider: memory
${extra}
    rules:
      - match: { tools: [Write] }
        required_role: owner
${grant}
downstream: []
audit: { path: a.jsonl }
`;
  it("parses grant and grant_max", () => {
    const c = parseConfig(base("    grant_max: 4h", "        grant: 15m"));
    expect(c.governance.approvals?.grant_max).toBe("4h");
    expect(c.governance.approvals?.rules[0].grant).toBe("15m");
    expect(parseConfig(base("", "        grant: once")).governance.approvals?.rules[0].grant).toBe("once");
  });
  it("absent grant stays undefined (default session applied at evaluation)", () => {
    expect(parseConfig(base("")).governance.approvals?.rules[0].grant).toBeUndefined();
  });
  it("rejects a typo'd grant rather than widening scope", () => {
    expect(() => parseConfig(base("", "        grant: forever"))).toThrow(/invalid approval grant/);
    expect(() => parseConfig(base("", "        grant: 0m"))).toThrow(/invalid approval grant/);
  });
  it("rejects an invalid grant_max", () => {
    expect(() => parseConfig(base("    grant_max: never"))).toThrow(/grant_max/);
  });
});

describe("proxy: audit + CLI", () => {
  function proxyConfig(dir: string, grant = "once") {
    return parseConfig(`
version: "1.0"
governance:
  domains: [{ manifest: ./no-such-knowledge.yaml, paths: [records/] }]
  policy: { fail_closed: true, audit_all: true }
  approvals:
    provider: file
    dir: ${dir}
    rules:
      - match: { tools: [Write], paths: [records/] }
        required_role: account-owner
        policy_ref: POL-7.2
        grant: ${grant}
downstream: []
audit: { path: .kcp-harness/audit.jsonl }
`);
  }
  async function write(proxy: HarnessProxy) {
    const r = (await proxy.handleMessage({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Write", arguments: ARGS },
    })) as { result: { content: Array<{ text: string }> } };
    // Governance passed => the only failure left is "no downstream owns Write".
    return { blocked: r.result.content[0].text.includes("BLOCKED") };
  }

  it("a second session's call is denied, audited as grant_denied/wrong_session, and visible in `approvals list`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grant-"));
    const cfg = proxyConfig(dir, "session");
    const auditA = new InMemoryAuditLog();
    const a = new HarnessProxy({ config: cfg, audit: auditA });
    await write(a);
    const provider = a.getApprovalProvider()!;
    const [t] = await provider.list({ state: "pending_review" });
    await provider.resolve({ id: t.request.id, state: "approved", reviewer: "Kari N.", reviewedAt: new Date().toISOString(), policyRef: "POL-7.2" });
    expect((await write(a)).blocked).toBe(false);

    const auditB = new InMemoryAuditLog();
    const b = new HarnessProxy({ config: cfg, audit: auditB });
    expect((await write(b)).blocked).toBe(true);
    const denied = auditB.events.filter((e) => e.type === "grant_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0].grant?.reason).toBe("wrong_session");
    expect(denied[0].grant?.ticketId).toBe(t.request.id);
    expect(auditB.events.filter((e) => e.type === "approval_requested")).toHaveLength(1);

    const listing = await runApprovals(["list"], cfg);
    expect(listing).toContain(t.request.id);
    expect(listing).toContain("approved");
    expect(listing).toContain("pending_review");
  });

  it("a consumed once grant shows as `used` in the CLI listing and in harness_approvals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grant-"));
    const cfg = proxyConfig(dir, "once");
    const audit = new InMemoryAuditLog();
    const proxy = new HarnessProxy({ config: cfg, audit });
    await write(proxy);
    const provider = proxy.getApprovalProvider()!;
    const [t] = await provider.list({ state: "pending_review" });
    await provider.resolve({ id: t.request.id, state: "approved", reviewer: "Kari N.", reviewedAt: new Date().toISOString(), policyRef: "POL-7.2" });
    expect((await write(proxy)).blocked).toBe(false);
    expect((await write(proxy)).blocked).toBe(true);

    expect(audit.events.find((e) => e.type === "grant_denied")?.grant?.reason).toBe("used");
    const listing = await runApprovals(["list", "--state", "used"], cfg);
    expect(listing).toContain(t.request.id);
    expect(listing).toContain("used");
    expect(readFileSync(join(dir, "approvals.jsonl"), "utf-8")).toContain('"kind":"use"');
  });

  it("an approved ticket past its grant is flagged in the listing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grant-"));
    const cfg = proxyConfig(dir, "session");
    const provider = new FileApprovalProvider(dir);
    await seedLegacy(provider, "old-session", 30 * H);
    expect(await runApprovals(["list"], cfg)).toContain("[grant expired]");
  });
});

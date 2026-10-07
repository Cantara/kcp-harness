// Ticket-store hardening: behaviour around the five S5 findings that the reproduction file
// (ticket-record-hardening-repro.test.ts) does not pin — store stamps, legacy time, signed lines
// appended directly, audit events, the listing flags, the args-binding config, config validation.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileApprovalProvider,
  InMemoryApprovalProvider,
  argsBindingOf,
  evaluateGrant,
  newRequest,
  resolveGrant,
  trustedResolutionTime,
  type ApprovalRequest,
  type ApprovalResolution,
  type ApprovalStatus,
} from "../src/approval.js";
import { checkGovernance, assertGovernableConfig, parseConfig } from "../src/config.js";
import { signResolution } from "../src/resolution-signature.js";
import { HarnessProxy } from "../src/proxy.js";
import { InMemoryAuditLog } from "../src/audit.js";
import { runApprovals } from "../src/approvals-cli.js";

const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-07T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const tmp = () => mkdtempSync(join(tmpdir(), "kcp-ticket-hardening-"));

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0); });
afterEach(() => { vi.useRealTimers(); });

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return newRequest({
    sessionId: "s1", toolName: "Write", target: "records/a.md", task: "t", requiredRole: "owner",
    grant: { mode: "session" }, argsDigest: "sha256:aa", evidence: { policyRef: "POL-1" }, ...over,
  });
}
const resolution = (id: string, over: Partial<ApprovalResolution> = {}): ApprovalResolution =>
  ({ id, state: "approved", reviewer: "Kari N.", reviewedAt: iso(Date.now()), policyRef: "POL-1", ...over });
const q = (over: Record<string, unknown> = {}) => ({
  target: "records/a.md", toolName: "Write", sessionId: "s1", argsDigest: "sha256:aa", maxMs: DAY, ...over,
});
const line = (r: ApprovalResolution) => JSON.stringify({ kind: "resolution", resolution: r }) + "\n";

function keypair() {
  const k = generateKeyPairSync("ed25519");
  return {
    priv: k.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: k.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
async function signed(req: ApprovalRequest, priv: string, over: Partial<ApprovalResolution> = {}): Promise<ApprovalResolution> {
  const res = resolution(req.id, over);
  res.signature = await signResolution(priv, {
    id: req.id, target: req.target, tool: req.toolName, state: res.state,
    reviewer: res.reviewer, policyRef: res.policyRef, timestamp: res.reviewedAt,
  });
  return res;
}

describe("trusted time: the store stamps resolutions", () => {
  it("resolve() stamps resolvedAtStore from the store's clock and overwrites a caller-supplied one", async () => {
    for (const p of [new FileApprovalProvider(tmp()), new InMemoryApprovalProvider()]) {
      const req = request();
      await p.submit(req);
      const status = await p.resolve(resolution(req.id, { resolvedAtStore: iso(T0 + 100 * DAY) }));
      expect(status.resolution?.resolvedAtStore).toBe(iso(T0));
      expect(status.trustedResolvedAt).toBe(iso(T0));
      expect(status.legacyTime).toBeUndefined();
    }
  });

  it("reviewedAt is kept as evidence, unchanged", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request();
    await p.submit(req);
    const reviewedAt = iso(T0 + 2 * MIN);
    const status = await p.resolve(resolution(req.id, { reviewedAt }));
    expect(status.resolution?.reviewedAt).toBe(reviewedAt);
  });

  it("a backdated reviewedAt (after requestedAt) does not shorten the window", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request();
    await p.submit(req);
    vi.setSystemTime(T0 + 20 * HOUR);
    await p.resolve(resolution(req.id, { reviewedAt: iso(T0 + MIN) }));
    vi.setSystemTime(T0 + 40 * HOUR); // 20h after the store saw it, 39h after the claimed time
    expect((await resolveGrant(p, q())).kind).toBe("granted");
  });

  it("the skew is configurable on the provider", async () => {
    const p = new FileApprovalProvider(tmp(), undefined, { maxSkewMs: 30 * 1000 });
    const req = request();
    await p.submit(req);
    await expect(p.resolve(resolution(req.id, { reviewedAt: iso(T0 + 2 * MIN) }))).rejects.toThrow(/ahead/);
    await p.resolve(resolution(req.id, { reviewedAt: iso(T0 + 10 * 1000) }));
  });

  it("a record whose own store stamp is in the future is ignored", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request();
    await p.submit(req);
    appendFileSync(p.getPath(), line(resolution(req.id, { resolvedAtStore: iso(T0 + 300 * DAY) })));
    const [s] = await p.list();
    expect(s.state).toBe("pending_review");
    expect(s.ignored?.[0].reason).toBe("future_dated");
  });

  it("legacy resolution (no stamp): window starts at min(reviewedAt, file mtime, now)", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request({ requestedAt: iso(T0 - 40 * HOUR) });
    await p.submit(req);
    // Written by an older harness: no resolvedAtStore. reviewedAt claims 1h ago ...
    appendFileSync(p.getPath(), line(resolution(req.id, { reviewedAt: iso(T0 - HOUR) })));
    // ... but the store file has not been touched for 30h.
    utimesSync(p.getPath(), new Date(T0 - 30 * HOUR), new Date(T0 - 30 * HOUR));
    const [s] = await p.list();
    expect(s.legacyTime).toBe(true);
    expect(s.trustedResolvedAt).toBe(iso(T0 - 30 * HOUR));
    expect((await resolveGrant(p, q())).kind).not.toBe("granted"); // 30h old > 24h cap
  });

  it("legacy resolution within skew in the future starts at now, not at the stamp", () => {
    const res = resolution("x", { reviewedAt: iso(T0 + 4 * MIN) });
    const t = trustedResolutionTime(res, T0, T0 - HOUR);
    expect(t).toEqual({ ms: T0 - HOUR, legacy: true });
    expect(trustedResolutionTime(res, T0, undefined).ms).toBe(T0);
  });

  it("evaluateGrant on a status with no trusted time refuses a future-dated reviewedAt", () => {
    const status: ApprovalStatus = {
      state: "approved",
      request: request(),
      resolution: resolution("x", { reviewedAt: iso(T0 + 365 * DAY) }),
    };
    expect(evaluateGrant(status, q()).ok).toBe(false);
  });
});

describe("signatures on the read path", () => {
  it("a validly signed record appended straight to the store is honoured", async () => {
    const { priv, pub } = keypair();
    const p = new FileApprovalProvider(tmp(), { requireSigned: true, trustedKeys: [pub] });
    const req = request();
    await p.submit(req);
    appendFileSync(p.getPath(), line(await signed(req, priv)));
    expect((await resolveGrant(p, q())).kind).toBe("granted");
  });

  it("a signature over different fields (reviewer swapped) is ignored as bad_signature", async () => {
    const { priv, pub } = keypair();
    const p = new FileApprovalProvider(tmp(), { requireSigned: true, trustedKeys: [pub] });
    const req = request();
    await p.submit(req);
    const res = await signed(req, priv);
    appendFileSync(p.getPath(), line({ ...res, reviewer: "Mallory" }));
    const [s] = await p.list();
    expect(s.state).toBe("pending_review");
    expect(s.ignored?.[0].reason).toBe("bad_signature");
  });

  it("an unsigned forged record does not shut out the real, later resolution", async () => {
    const { priv, pub } = keypair();
    const p = new FileApprovalProvider(tmp(), { requireSigned: true, trustedKeys: [pub] });
    const req = request();
    await p.submit(req);
    appendFileSync(p.getPath(), line(resolution(req.id, { state: "dismissed" })));
    await p.resolve(await signed(req, priv));
    const [s] = await p.list();
    expect(s.state).toBe("approved");
    expect(s.ignored?.map((r) => r.reason)).toEqual(["unsigned"]);
  });

  it("without require_signed_resolutions an unsigned line is accepted (documented limit)", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request();
    await p.submit(req);
    appendFileSync(p.getPath(), line(resolution(req.id)));
    expect((await resolveGrant(p, q())).kind).toBe("granted");
  });
});

describe("first terminal resolution wins", () => {
  it("two concurrent resolve() calls: exactly one succeeds", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request();
    await p.submit(req);
    const results = await Promise.allSettled([
      p.resolve(resolution(req.id, { state: "approved" })),
      p.resolve(resolution(req.id, { state: "dismissed" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [s] = await p.list();
    expect(["approved", "dismissed"]).toContain(s.state);
  });

  it("extra records are counted per ticket", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request();
    await p.submit(req);
    await p.resolve(resolution(req.id, { state: "dismissed" }));
    for (let i = 0; i < 3; i++) appendFileSync(p.getPath(), line(resolution(req.id)));
    const [s] = await p.list();
    expect(s.ignored?.filter((r) => r.reason === "extra_record")).toHaveLength(3);
  });

  it("a duplicate request line cannot replace the ticket's terms", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request({ grant: { mode: "once" } });
    await p.submit(req);
    appendFileSync(p.getPath(), JSON.stringify({ kind: "request", request: { ...req, grant: { mode: "session" }, argsDigest: undefined } }) + "\n");
    const all = await p.list();
    expect(all).toHaveLength(1);
    expect(all[0].request.grant?.mode).toBe("once");
  });

  it("the once-grant compare-and-swap still yields exactly one winner", async () => {
    for (const p of [new FileApprovalProvider(tmp()), new InMemoryApprovalProvider()]) {
      const req = request({ grant: { mode: "once" } });
      await p.submit(req);
      await p.resolve(resolution(req.id));
      const outcomes = await Promise.all(Array.from({ length: 50 }, () => resolveGrant(p, q())));
      expect(outcomes.filter((o) => o.kind === "granted")).toHaveLength(1);
    }
  });
});

describe("args binding", () => {
  it("newRequest keeps a digest when given and adds no flag", () => {
    const r = request();
    expect(r.argsDigest).toBe("sha256:aa");
    expect(r.argsBound).toBeUndefined();
    expect(argsBindingOf(r)).toBe("bound");
  });

  it("newRequest records an explicit reason when the caller supplies one", () => {
    const r = newRequest({
      sessionId: "s", toolName: "harness_assess", target: "t", task: "t", requiredRole: "r",
      argsBound: false, argsUnboundReason: "no_call_arguments", evidence: {},
    });
    expect(r.argsBound).toBe(false);
    expect(r.argsUnboundReason).toBe("no_call_arguments");
    expect(argsBindingOf(r)).toBe("unbound");
  });

  async function unboundGrant(over: { legacy?: boolean; mode?: "once" | "session" | "duration"; reason?: string } = {}) {
    const p = new InMemoryApprovalProvider();
    const req = request({
      grant: over.mode === "duration" ? { mode: "duration", durationMs: HOUR } : { mode: over.mode ?? "session" },
      argsDigest: undefined,
      argsBound: false,
      argsUnboundReason: over.reason ?? "not_supplied",
    });
    delete (req as { argsDigest?: string }).argsDigest;
    if (over.legacy) {
      delete (req as { argsBound?: false }).argsBound;
      delete (req as { argsUnboundReason?: string }).argsUnboundReason;
    }
    await p.submit(req);
    await p.resolve(resolution(req.id));
    return p;
  }

  it("an unbound ticket is a grant for the exact (tool, target) with session or once, and is reported", async () => {
    for (const mode of ["session", "once"] as const) {
      const p = await unboundGrant({ mode });
      const o = await resolveGrant(p, q({ argsDigest: "sha256:whatever" }));
      expect(o.kind).toBe("granted");
      expect((o as { unbound?: { binding: string } }).unbound?.binding).toBe("unbound");
    }
  });

  it("an unbound ticket never covers another (tool, target)", async () => {
    const p = await unboundGrant();
    expect((await resolveGrant(p, q({ target: "records/other.md" }))).kind).not.toBe("granted");
    expect((await resolveGrant(p, q({ toolName: "Edit" }))).kind).not.toBe("granted");
  });

  it("an unbound ticket stays within grant_max", async () => {
    const p = await unboundGrant();
    vi.setSystemTime(T0 + DAY + MIN);
    expect((await resolveGrant(p, q())).kind).not.toBe("granted");
  });

  it("a legacy ticket keeps the pre-binding rule (duration allowed) and is reported as legacy", async () => {
    const p = await unboundGrant({ legacy: true, mode: "duration" });
    const o = await resolveGrant(p, q());
    expect(o.kind).toBe("granted");
    expect((o as { unbound?: { binding: string } }).unbound?.binding).toBe("legacy");
  });

  it("require_args_binding refuses unbound and legacy tickets, with detail args_unbound", async () => {
    for (const legacy of [false, true]) {
      const p = await unboundGrant({ legacy });
      const o = await resolveGrant(p, q({ requireArgsBinding: true }));
      expect(o.kind).toBe("open");
      expect((o as { denied?: { reason: string; detail?: string } }).denied).toMatchObject({ reason: "invalid", detail: "args_unbound" });
    }
  });

  it("require_args_binding exempts a call that has no arguments (no_call_arguments)", async () => {
    const p = await unboundGrant({ reason: "no_call_arguments" });
    expect((await resolveGrant(p, q({ requireArgsBinding: true }))).kind).toBe("granted");
  });

  it("config: require_args_binding and max_reviewed_at_skew parse; bad skew is rejected", () => {
    const base = (extra: string) => parseConfig(`
governance:
  domains: [{ manifest: ./k.yaml, paths: [records/] }]
  approvals:
    rules: []
${extra}`);
    const a = base("    require_args_binding: true\n    max_reviewed_at_skew: 2m\n").governance.approvals!;
    expect(a.require_args_binding).toBe(true);
    expect(a.max_reviewed_at_skew).toBe("2m");
    expect(base("").governance.approvals!.require_args_binding).toBe(false);
    expect(() => base("    max_reviewed_at_skew: soon\n")).toThrow(/max_reviewed_at_skew/);
  });
});

// -- Through the proxy: audit events and the tool surface ------------------------

function fileProxyConfig(dir: string, extra = "") {
  return parseConfig(`
version: "1.0"
governance:
  domains:
    - manifest: ./no-such-knowledge.yaml
      paths: [records/]
  policy: { fail_closed: true, audit_all: true }
  approvals:
    provider: file
    dir: ${dir}
${extra}
    rules:
      - match: { tools: [Write], paths: [records/] }
        required_role: account-owner
        policy_ref: POL-7.2
  confidence: { threshold: 0.7, route_to_role: account-owner, policy_ref: POL-9.1 }
downstream: []
audit: { path: .kcp-harness/audit.jsonl }
`);
}

async function callTool(proxy: HarnessProxy, name: string, args: Record<string, unknown>) {
  const r = (await proxy.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as
    { result: { content: Array<{ text: string }>; isError: boolean } };
  return r.result;
}
const WRITE = { file_path: "records/a.md", content: "x" };

describe("proxy: audit and listing", () => {
  it("an unsigned line appended to the store: grant_denied `invalid`, one approval_record_ignored", async () => {
    const dir = tmp();
    const audit = new InMemoryAuditLog();
    const proxy = new HarnessProxy({ config: fileProxyConfig(dir, "    require_signed_resolutions: true"), audit });
    await callTool(proxy, "Write", WRITE); // opens the ticket
    const provider = proxy.getApprovalProvider() as FileApprovalProvider;
    const [t] = await provider.list();
    appendFileSync(provider.getPath(), line(resolution(t.request.id)));
    appendFileSync(provider.getPath(), line(resolution(t.request.id, { state: "dismissed" })));

    const r1 = await callTool(proxy, "Write", WRITE);
    const r2 = await callTool(proxy, "Write", WRITE);
    expect(r1.isError).toBe(true);
    expect(r2.isError).toBe(true);
    const denied = audit.events.filter((e) => e.type === "grant_denied");
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied[0].grant?.reason).toBe("invalid");
    expect(denied[0].grant?.ticketId).toBe(t.request.id);
    expect(audit.events.filter((e) => e.type === "approval_record_ignored")).toHaveLength(1);
    // still only the one ticket: an ignored record does not trigger a second request
    expect(audit.events.filter((e) => e.type === "approval_requested")).toHaveLength(1);
  });

  it("a record appended after a dismissal is audited once, however often the ticket is read", async () => {
    const dir = tmp();
    const audit = new InMemoryAuditLog();
    const proxy = new HarnessProxy({ config: fileProxyConfig(dir), audit });
    await callTool(proxy, "Write", WRITE);
    const provider = proxy.getApprovalProvider() as FileApprovalProvider;
    const [t] = await provider.list();
    await provider.resolve(resolution(t.request.id, { state: "dismissed" }));
    appendFileSync(provider.getPath(), line(resolution(t.request.id)));
    for (let i = 0; i < 3; i++) {
      const r = await callTool(proxy, "Write", WRITE);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("dismissed");
    }
    await callTool(proxy, "harness_approvals", {});
    expect(audit.events.filter((e) => e.type === "approval_record_ignored")).toHaveLength(1);
  });

  it("harness_approvals exposes ignored records, binding and trusted time", async () => {
    const dir = tmp();
    const proxy = new HarnessProxy({ config: fileProxyConfig(dir), audit: new InMemoryAuditLog() });
    await callTool(proxy, "Write", WRITE);
    const provider = proxy.getApprovalProvider() as FileApprovalProvider;
    const [t] = await provider.list();
    await provider.resolve(resolution(t.request.id));
    appendFileSync(provider.getPath(), line(resolution(t.request.id, { state: "dismissed" })));
    const out = JSON.parse((await callTool(proxy, "harness_approvals", {})).content[0].text) as { approvals: Array<Record<string, unknown>> };
    expect(out.approvals[0]["argsBinding"]).toBe("bound");
    expect(out.approvals[0]["trustedResolvedAt"]).toBe(iso(T0));
    expect((out.approvals[0]["ignored"] as Array<{ reason: string }>)[0].reason).toBe("extra_record");
  });

  it("a grant from a legacy (unbound) ticket is audited as grant_unbound and carried on the decision", async () => {
    const dir = tmp();
    const audit = new InMemoryAuditLog();
    const proxy = new HarnessProxy({ config: fileProxyConfig(dir), audit });
    const provider = proxy.getApprovalProvider() as FileApprovalProvider;
    // a pre-binding ticket for this very session
    const sessionId = (proxy as unknown as { session: { id: string } }).session.id;
    const legacy = request({ sessionId, argsDigest: undefined });
    delete (legacy as { argsDigest?: string }).argsDigest;
    delete (legacy as { argsBound?: false }).argsBound;
    delete (legacy as { argsUnboundReason?: string }).argsUnboundReason;
    await provider.submit(legacy);
    await provider.resolve(resolution(legacy.id));

    await callTool(proxy, "Write", WRITE);
    const unbound = audit.events.filter((e) => e.type === "grant_unbound");
    expect(unbound).toHaveLength(1);
    expect(unbound[0].unboundGrant).toMatchObject({ ticketId: legacy.id, binding: "legacy" });
  });

  it("govern() carries grantUnbound on the decision", async () => {
    const { govern } = await import("../src/governor.js");
    const { createSession } = await import("../src/session.js");
    const provider = new InMemoryApprovalProvider();
    const session = createSession();
    const legacy = request({ sessionId: session.id });
    delete (legacy as { argsDigest?: string }).argsDigest;
    delete (legacy as { argsBound?: false }).argsBound;
    delete (legacy as { argsUnboundReason?: string }).argsUnboundReason;
    await provider.submit(legacy);
    await provider.resolve(resolution(legacy.id));
    const d = await govern(
      { governed: true, reason: "governed", domain: { manifest: "./none.yaml", paths: ["records/"] }, target: "records/a.md" } as never,
      "Write", WRITE, session,
      { fail_closed: true, audit_all: true, max_units: 5, strict: false },
      { provider, rules: [{ match: { tools: ["Write"], paths: ["records/"] }, required_role: "o" }] },
    );
    expect(d.approved).toBe(true);
    expect(d.grantUnbound).toMatchObject({ ticketId: legacy.id, binding: "legacy" });
  });

  it("require_args_binding in config: the same legacy ticket no longer grants and a bound one is opened", async () => {
    const dir = tmp();
    const audit = new InMemoryAuditLog();
    const proxy = new HarnessProxy({ config: fileProxyConfig(dir, "    require_args_binding: true"), audit });
    const provider = proxy.getApprovalProvider() as FileApprovalProvider;
    const sessionId = (proxy as unknown as { session: { id: string } }).session.id;
    const legacy = request({ sessionId });
    delete (legacy as { argsDigest?: string }).argsDigest;
    delete (legacy as { argsBound?: false }).argsBound;
    delete (legacy as { argsUnboundReason?: string }).argsUnboundReason;
    await provider.submit(legacy);
    await provider.resolve(resolution(legacy.id));

    const r = await callTool(proxy, "Write", WRITE);
    expect(r.isError).toBe(true);
    expect(audit.events.find((e) => e.type === "grant_denied")?.grant).toMatchObject({ reason: "invalid", detail: "args_unbound" });
    const tickets = await provider.list();
    expect(tickets).toHaveLength(2);
    expect(tickets[1].request.argsDigest).toMatch(/^sha256:/);
  });

  it("harness_assess tickets are explicitly unbound with reason no_call_arguments", async () => {
    const dir = tmp();
    const proxy = new HarnessProxy({ config: fileProxyConfig(dir), audit: new InMemoryAuditLog() });
    await callTool(proxy, "harness_assess", { task: "summarise records/a.md", answer: "Unsure. Confidence: 0.2" });
    const [t] = await (proxy.getApprovalProvider() as FileApprovalProvider).list();
    expect(t.request.toolName).toBe("harness_assess");
    expect(t.request.argsBound).toBe(false);
    expect(t.request.argsUnboundReason).toBe("no_call_arguments");
  });
});

describe("approvals list flags", () => {
  function cfg(dir: string) {
    const c = fileProxyConfig(dir, "    require_signed_resolutions: true");
    return c;
  }

  it("shows [unsigned: ignored], [extra record ignored], [args unbound] and [legacy: args unbound]", async () => {
    const dir = tmp();
    const config = cfg(dir);
    const p = new FileApprovalProvider(dir, { requireSigned: true, trustedKeys: [] });
    const { priv } = keypair();

    const a = request({ target: "records/a.md" });
    await p.submit(a);
    appendFileSync(p.getPath(), line(resolution(a.id))); // unsigned

    const b = request({ target: "records/b.md" });
    await p.submit(b);
    await p.resolve(await signed(b, priv, { state: "dismissed" }));
    appendFileSync(p.getPath(), line(resolution(b.id))); // extra

    const c = newRequest({ sessionId: "s1", toolName: "Write", target: "records/c.md", task: "t", requiredRole: "o", evidence: {} });
    await p.submit(c); // unbound (explicit)

    const d = request({ target: "records/d.md" });
    delete (d as { argsDigest?: string }).argsDigest;
    await p.submit(d); // legacy: no digest and no flag

    const out = await runApprovals(["list"], config);
    const lineOf = (id: string) => out.split("\n").find((l) => l.startsWith(id)) ?? "";
    expect(lineOf(a.id)).toContain("pending_review");
    expect(lineOf(a.id)).toContain("[unsigned: ignored]");
    expect(lineOf(b.id)).toContain("[extra record ignored]");
    expect(lineOf(c.id)).toContain("[args unbound: not_supplied]");
    expect(lineOf(d.id)).toContain("[legacy: args unbound]");
  });
});

// -- 5. config validation ------------------------------------------------------------

describe("config governs something", () => {
  const cfg = (body: string) => parseConfig(body);

  it("rules with no domains: error; domains covering nothing: error; both refuse start", () => {
    const noDomains = cfg("governance:\n  approvals:\n    rules:\n      - { match: { tools: [Write] }, required_role: o }\n");
    expect(checkGovernance(noDomains).errors[0]).toMatch(/domains is empty/);
    expect(() => assertGovernableConfig(noDomains)).toThrow(/no call is ever classified as governed/);

    const empty = cfg("governance:\n  domains:\n    - manifest: ./k.yaml\n");
    expect(checkGovernance(empty).errors[0]).toMatch(/none names a path, url, tool or skill/);
  });

  it("a domain that names only tools or skills counts as covering something", () => {
    const toolOnly = cfg("governance:\n  domains:\n    - { manifest: ./k.yaml, tools: [kb_read] }\n");
    expect(checkGovernance(toolOnly).errors).toEqual([]);
  });

  it("no domains and no rules: a warning (nothing governed), not an error", () => {
    const c = cfg("governance: {}\n");
    const r = checkGovernance(c);
    expect(r.errors).toEqual([]);
    expect(r.warnings[0]).toMatch(/nothing is governed/);
  });

  it("warns when no rule's paths overlap any domain path", () => {
    const c = cfg(`
governance:
  domains: [{ manifest: ./k.yaml, paths: [docs/] }]
  approvals:
    rules:
      - { match: { tools: [Write], paths: [records/] }, required_role: o }
`);
    const r = checkGovernance(c);
    expect(r.errors).toEqual([]);
    expect(r.warnings[0]).toMatch(/no rule's match.paths overlaps/);
  });

  it("no warning when a rule path is inside, or contains, a domain path, or the rule has no paths", () => {
    for (const rulePath of ["docs/api/", "docs/", "./"]) {
      const c = cfg(`
governance:
  domains: [{ manifest: ./k.yaml, paths: [docs/] }]
  approvals:
    rules:
      - { match: { paths: [${rulePath}] }, required_role: o }
`);
      // "./" does not overlap "docs/" under prefix matching, so it is the one that warns.
      const w = checkGovernance(c).warnings;
      expect(w.length).toBe(rulePath === "./" ? 1 : 0);
    }
    const anyPath = cfg("governance:\n  domains: [{ manifest: ./k.yaml, paths: [docs/] }]\n  approvals:\n    rules:\n      - { match: { tools: [Write] }, required_role: o }\n");
    expect(checkGovernance(anyPath).warnings).toEqual([]);
  });

  it("non-mapping roots and a wrong-typed governance block are parse errors", () => {
    expect(() => cfg("- a\n- b\n")).toThrow(/mapping/);
    expect(() => cfg("governance: [1, 2]\n")).toThrow(/governance must be a mapping/);
    expect(() => cfg("governance:\n  domains: {a: 1}\n")).toThrow(/domains must be a list/);
  });

  it("an existing valid config is unaffected", () => {
    const c = cfg("version: '1.0'\ngovernance:\n  domains:\n    - { manifest: ./k.yaml, paths: [docs/, src/] }\n");
    expect(checkGovernance(c)).toEqual({ errors: [], warnings: [] });
  });
});

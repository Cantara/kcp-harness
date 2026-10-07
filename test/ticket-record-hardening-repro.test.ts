// Reproduction of five ticket-store findings from experiment S5 (Sunstone Atlas,
// docs/experiments/approval-ladder-sim, README section S5). Each test states the property that
// must hold and uses the pre-fix public API, so it fails against v0.16.0 and passes after the fix.
//
//   1. reviewedAt is trusted: a future-dated stamp lifts the grant_max cap.
//   2. require_signed_resolutions is enforced in resolve() only, not when the log is read.
//   3. A terminal ticket can be re-resolved by an appended record (later record wins on replay).
//   4. A ticket without argsDigest covers any arguments.
//   5. A config that parses but governs nothing is accepted silently.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileApprovalProvider,
  InMemoryApprovalProvider,
  newRequest,
  resolveGrant,
  type ApprovalRequest,
  type ApprovalResolution,
} from "../src/approval.js";
import { govern } from "../src/governor.js";
import { createSession } from "../src/session.js";
import type { Classification } from "../src/classifier.js";
import type { GovernancePolicy, ApprovalRule } from "../src/config.js";
import * as configModule from "../src/config.js";
import { signResolution } from "../src/resolution-signature.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-07T10:00:00.000Z");
const MAX = DAY;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const iso = (ms: number) => new Date(ms).toISOString();
const tmp = () => mkdtempSync(join(tmpdir(), "kcp-ticket-hardening-"));

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return newRequest({
    sessionId: "s1",
    toolName: "Write",
    target: "records/a.md",
    task: "t",
    requiredRole: "owner",
    grant: { mode: "session" },
    argsDigest: "sha256:aa",
    evidence: { policyRef: "POL-1" },
    ...over,
  });
}

function resolution(id: string, over: Partial<ApprovalResolution> = {}): ApprovalResolution {
  return { id, state: "approved", reviewer: "Kari N.", reviewedAt: iso(Date.now()), policyRef: "POL-1", ...over };
}

const q = (over: Record<string, unknown> = {}) => ({
  target: "records/a.md",
  toolName: "Write",
  sessionId: "s1",
  argsDigest: "sha256:aa",
  maxMs: MAX,
  ...over,
});

const line = (r: ApprovalResolution) => JSON.stringify({ kind: "resolution", resolution: r }) + "\n";

// -- 1. reviewedAt is not a trusted clock --------------------------------------

describe("finding 1: a grant's validity is measured from a trusted time, not reviewedAt", () => {
  it("a resolution appended with reviewedAt a year in the future is not a grant, now or 300 days later", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request();
    await p.submit(req);
    appendFileSync(p.getPath(), line(resolution(req.id, { reviewedAt: iso(T0 + 365 * DAY) })));

    expect((await resolveGrant(p, q())).kind).not.toBe("granted");
    vi.setSystemTime(T0 + 300 * DAY);
    expect((await resolveGrant(p, q())).kind).not.toBe("granted");
  });

  it("resolve() refuses a reviewedAt far in the future", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request();
    await p.submit(req);
    await expect(p.resolve(resolution(req.id, { reviewedAt: iso(T0 + 365 * DAY) }))).rejects.toThrow();
  });

  it("resolve() refuses a reviewedAt earlier than the ticket's requestedAt", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request();
    await p.submit(req);
    vi.setSystemTime(T0 + HOUR);
    await expect(p.resolve(resolution(req.id, { reviewedAt: iso(T0 - HOUR) }))).rejects.toThrow();
  });

  for (const kind of ["file", "memory"] as const) {
    it(`grant_max is measured from when the store saw the resolution, not from a stamp inside the skew (${kind})`, async () => {
      const p = kind === "file" ? new FileApprovalProvider(tmp()) : new InMemoryApprovalProvider();
      const req = request();
      await p.submit(req);
      // 4 minutes ahead: inside any sane skew tolerance, so the resolution itself is accepted.
      await p.resolve(resolution(req.id, { reviewedAt: iso(T0 + 4 * 60_000) }));
      expect((await resolveGrant(p, q())).kind).toBe("granted");

      // 24h + 2min after the store wrote it: the cap has passed. The stamp claimed +4min.
      vi.setSystemTime(T0 + DAY + 2 * 60_000);
      expect((await resolveGrant(p, q())).kind).not.toBe("granted");
    });
  }
});

// -- 2. signatures are verified when the log is read ----------------------------

describe("finding 2: require_signed_resolutions holds on the read path", () => {
  it("an unsigned resolution line appended to the store is not a grant", async () => {
    const p = new FileApprovalProvider(tmp(), { requireSigned: true, trustedKeys: [] });
    const req = request();
    await p.submit(req);
    appendFileSync(p.getPath(), line(resolution(req.id)));

    const outcome = await resolveGrant(p, q());
    expect(outcome.kind).not.toBe("granted");
    const [status] = await p.list();
    expect(status.state).toBe("pending_review");
  });

  it("the denial is audited as reason `invalid`", async () => {
    const p = new FileApprovalProvider(tmp(), { requireSigned: true, trustedKeys: [] });
    const req = request();
    await p.submit(req);
    appendFileSync(p.getPath(), line(resolution(req.id)));

    const outcome = (await resolveGrant(p, q())) as { denied?: { reason: string } };
    expect(outcome.denied?.reason).toBe("invalid");
  });

  it("a line signed by a key that is not trusted is not a grant", async () => {
    const trusted = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const trustedPem = trusted.publicKey.export({ type: "spki", format: "pem" }).toString();
    const p = new FileApprovalProvider(tmp(), { requireSigned: true, trustedKeys: [trustedPem] });
    const req = request();
    await p.submit(req);
    const res = resolution(req.id);
    res.signature = await signResolution(
      other.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      { id: req.id, target: req.target, tool: req.toolName, state: res.state, reviewer: res.reviewer, policyRef: res.policyRef, timestamp: res.reviewedAt },
    );
    appendFileSync(p.getPath(), line(res));
    expect((await resolveGrant(p, q())).kind).not.toBe("granted");
  });
});

// -- 3. first terminal resolution wins -------------------------------------------

describe("finding 3: a terminal ticket cannot be re-resolved by an appended record", () => {
  it("a dismissed ticket re-approved by an appended record stays dismissed", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request();
    await p.submit(req);
    await p.resolve(resolution(req.id, { state: "dismissed" }));
    appendFileSync(p.getPath(), line(resolution(req.id, { state: "approved" })));

    const [status] = await p.list();
    expect(status.state).toBe("dismissed");
    expect((await resolveGrant(p, q())).kind).not.toBe("granted");
  });

  it("an approved ticket flipped to dismissed by an appended record keeps its first resolution", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request();
    await p.submit(req);
    await p.resolve(resolution(req.id, { state: "approved" }));
    appendFileSync(p.getPath(), line(resolution(req.id, { state: "dismissed" })));
    const [status] = await p.list();
    expect(status.state).toBe("approved");
  });

  it("a `used` ticket stays used when a later resolution record is appended", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request({ grant: { mode: "once" } });
    await p.submit(req);
    await p.resolve(resolution(req.id));
    expect((await resolveGrant(p, q())).kind).toBe("granted");
    appendFileSync(p.getPath(), line(resolution(req.id, { state: "dismissed" })));
    const [status] = await p.list();
    expect(status.state).toBe("used");
  });

  it("a record appended after the ticket's TTL does not resurrect an expired ticket", async () => {
    const p = new FileApprovalProvider(tmp());
    const req = request({ expiresAt: iso(T0 + 10 * 60_000) });
    await p.submit(req);
    vi.setSystemTime(T0 + HOUR);
    appendFileSync(p.getPath(), line(resolution(req.id, { reviewedAt: iso(T0 + HOUR), resolvedAtStore: iso(T0 + HOUR) } as Partial<ApprovalResolution>)));
    const [status] = await p.list();
    expect(status.state).toBe("expired");
    expect((await resolveGrant(p, q())).kind).not.toBe("granted");
  });
});

// -- 4. argument binding ----------------------------------------------------------

describe("finding 4: a ticket without an argsDigest does not silently cover any arguments", () => {
  it("newRequest without a digest is explicitly marked unbound, with a reason", () => {
    const r = newRequest({
      sessionId: "s1", toolName: "Write", target: "records/a.md", task: "t", requiredRole: "owner", evidence: {},
    });
    const explicit = (r as ApprovalRequest & { argsBound?: boolean; argsUnboundReason?: string });
    expect(r.argsDigest !== undefined || explicit.argsBound === false).toBe(true);
    if (explicit.argsBound === false) expect(explicit.argsUnboundReason).toBeTruthy();
  });

  it("an unbound ticket is not a grant when its mode is a duration", async () => {
    const p = new InMemoryApprovalProvider();
    const req = request({ grant: { mode: "duration", durationMs: HOUR } });
    delete (req as { argsDigest?: string }).argsDigest;
    (req as ApprovalRequest & { argsBound?: boolean; argsUnboundReason?: string }).argsBound = false;
    (req as ApprovalRequest & { argsBound?: boolean; argsUnboundReason?: string }).argsUnboundReason = "test";
    await p.submit(req);
    await p.resolve(resolution(req.id));
    expect((await resolveGrant(p, q({ argsDigest: "sha256:anything" }))).kind).not.toBe("granted");
  });

  it("require_args_binding makes an unbound grant invalid", async () => {
    const policy: GovernancePolicy = { fail_closed: true, audit_all: true, max_units: 5, strict: false };
    const rule: ApprovalRule = { match: { tools: ["Write"], paths: ["records/"] }, required_role: "owner", grant: "session" };
    const provider = new InMemoryApprovalProvider();
    const session = createSession();
    const legacy = request({ sessionId: session.id });
    delete (legacy as { argsDigest?: string }).argsDigest; // a legacy ticket: no digest, no flag
    await provider.submit(legacy);
    await provider.resolve(resolution(legacy.id));
    const cls = {
      governed: true, reason: "governed",
      domain: { manifest: "./none.yaml", paths: ["records/"] },
      target: "records/a.md",
    } as Classification;

    const open = await govern(cls, "Write", { file_path: "records/a.md" }, session, policy, { provider, rules: [rule] });
    expect(open.approved).toBe(true); // compatibility default: legacy tickets stay valid

    const strict = await govern(cls, "Write", { file_path: "records/a.md" }, session, policy, {
      provider, rules: [rule], requireArgsBinding: true,
    } as never);
    expect(strict.approved).toBe(false);
  });
});

// -- 5. a config that governs nothing ------------------------------------------------

describe("finding 5: a config that governs nothing is refused by check and proxy start", () => {
  const assertGovernable = (configModule as Record<string, unknown>)["assertGovernableConfig"] as
    | ((c: configModule.HarnessConfig) => unknown)
    | undefined;

  const parse = (yamlText: string) => configModule.parseConfig(yamlText);

  it("approval rules but no governed domain is an error", () => {
    const c = parse(`
governance:
  approvals:
    rules:
      - match: { tools: [Write] }
        required_role: owner
`);
    expect(() => assertGovernable!(c)).toThrow(/domain/i);
  });

  it("domains that cover no path, url, tool or skill are an error", () => {
    const c = parse(`
governance:
  domains:
    - manifest: ./knowledge.yaml
  approvals:
    rules:
      - match: { tools: [Write] }
        required_role: owner
`);
    expect(() => assertGovernable!(c)).toThrow(/cover|path/i);
  });

  it("a well-formed config passes", () => {
    const c = parse(`
governance:
  domains:
    - manifest: ./knowledge.yaml
      paths: [records/]
  approvals:
    rules:
      - match: { tools: [Write], paths: [records/] }
        required_role: owner
`);
    expect(() => assertGovernable!(c)).not.toThrow();
  });

  it("a wrong-typed governance.domains is rejected at parse time instead of becoming an empty list", () => {
    expect(() => parse("governance:\n  domains: 7\n")).toThrow();
    expect(() => parse("- a\n- b\n")).toThrow();
  });
});

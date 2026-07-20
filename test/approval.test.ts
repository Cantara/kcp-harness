// Approval core — the four-state machine and its providers.
//
// pending_review ─▶ approved | dismissed (terminal, by a named reviewer)
//        └───────▶ expired (terminal, via TTL)
//
// Resolutions REQUIRE reviewer + policyRef — evidence is generated at
// approval time, never reconstructed later. The FileApprovalProvider must
// survive process restart (the pilot's minutes-to-days requirement).

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryApprovalProvider,
  FileApprovalProvider,
  newRequest,
  parseDuration,
  latestForCall,
  type ApprovalProvider,
} from "../src/approval.js";

function req(overrides: Record<string, unknown> = {}) {
  return newRequest({
    sessionId: "s-1",
    toolName: "Write",
    target: "records/customer-7.md",
    task: "update account status",
    requiredRole: "account-owner",
    evidence: { manifest: "./knowledge.yaml", policyRef: "POL-7.2" },
    ...overrides,
  });
}

function providers(): Array<{ name: string; make: () => ApprovalProvider }> {
  return [
    { name: "InMemoryApprovalProvider", make: () => new InMemoryApprovalProvider() },
    {
      name: "FileApprovalProvider",
      make: () => new FileApprovalProvider(mkdtempSync(join(tmpdir(), "kcp-approvals-"))),
    },
  ];
}

for (const { name, make } of providers()) {
  describe(name, () => {
    it("submit creates a pending_review ticket", async () => {
      const p = make();
      const r = req();
      await p.submit(r);
      const status = await p.check(r.id);
      expect(status?.state).toBe("pending_review");
      expect(status?.request.requiredRole).toBe("account-owner");
      expect(status?.resolution).toBeUndefined();
    });

    it("check on unknown id returns undefined", async () => {
      const p = make();
      expect(await p.check("nope")).toBeUndefined();
    });

    it("approve resolves with named reviewer and policyRef", async () => {
      const p = make();
      const r = req();
      await p.submit(r);
      const status = await p.resolve({
        id: r.id,
        state: "approved",
        reviewer: "Kari N.",
        reviewedAt: new Date().toISOString(),
        policyRef: "POL-7.2",
      });
      expect(status.state).toBe("approved");
      expect(status.resolution?.reviewer).toBe("Kari N.");
      expect(status.resolution?.policyRef).toBe("POL-7.2");
    });

    it("dismiss is a terminal outcome with a reviewer", async () => {
      const p = make();
      const r = req();
      await p.submit(r);
      const status = await p.resolve({
        id: r.id,
        state: "dismissed",
        reviewer: "Kari N.",
        reviewedAt: new Date().toISOString(),
        policyRef: "POL-7.2",
        note: "not warranted",
      });
      expect(status.state).toBe("dismissed");
      expect(status.resolution?.note).toBe("not warranted");
    });

    it("rejects a resolution without a named reviewer", async () => {
      const p = make();
      const r = req();
      await p.submit(r);
      await expect(
        p.resolve({ id: r.id, state: "approved", reviewer: "", reviewedAt: new Date().toISOString(), policyRef: "POL-7.2" }),
      ).rejects.toThrow(/reviewer/);
    });

    it("rejects a resolution without a policyRef — approved:true alone is not evidence", async () => {
      const p = make();
      const r = req();
      await p.submit(r);
      await expect(
        p.resolve({ id: r.id, state: "approved", reviewer: "Kari N.", reviewedAt: new Date().toISOString(), policyRef: "" }),
      ).rejects.toThrow(/policyRef/);
    });

    it("rejects resolving a ticket twice — terminal states are terminal", async () => {
      const p = make();
      const r = req();
      await p.submit(r);
      const res = { id: r.id, state: "approved" as const, reviewer: "Kari N.", reviewedAt: new Date().toISOString(), policyRef: "POL-7.2" };
      await p.resolve(res);
      await expect(p.resolve(res)).rejects.toThrow(/terminal|resolved/i);
    });

    it("rejects resolving an unknown ticket", async () => {
      const p = make();
      await expect(
        p.resolve({ id: "nope", state: "approved", reviewer: "K", reviewedAt: new Date().toISOString(), policyRef: "P" }),
      ).rejects.toThrow(/unknown/i);
    });

    it("a pending ticket past its expiresAt reads as expired — fail-closed", async () => {
      const p = make();
      const r = req({ expiresAt: new Date(Date.now() - 1000).toISOString() });
      await p.submit(r);
      const status = await p.check(r.id);
      expect(status?.state).toBe("expired");
    });

    it("rejects resolving an expired ticket", async () => {
      const p = make();
      const r = req({ expiresAt: new Date(Date.now() - 1000).toISOString() });
      await p.submit(r);
      await expect(
        p.resolve({ id: r.id, state: "approved", reviewer: "K", reviewedAt: new Date().toISOString(), policyRef: "P" }),
      ).rejects.toThrow(/expired/i);
    });

    it("an approval resolved before expiry stays approved after the TTL passes", async () => {
      const p = make();
      const r = req({ expiresAt: new Date(Date.now() + 50).toISOString() });
      await p.submit(r);
      await p.resolve({ id: r.id, state: "approved", reviewer: "K", reviewedAt: new Date().toISOString(), policyRef: "P" });
      await new Promise((resolve) => setTimeout(resolve, 60));
      const status = await p.check(r.id);
      expect(status?.state).toBe("approved");
    });

    it("list filters by state", async () => {
      const p = make();
      const a = req();
      const b = req({ target: "records/customer-8.md" });
      await p.submit(a);
      await p.submit(b);
      await p.resolve({ id: a.id, state: "approved", reviewer: "K", reviewedAt: new Date().toISOString(), policyRef: "P" });
      const pending = await p.list({ state: "pending_review" });
      expect(pending.map((s) => s.request.id)).toEqual([b.id]);
      const all = await p.list();
      expect(all).toHaveLength(2);
    });
  });
}

describe("FileApprovalProvider persistence", () => {
  it("survives a restart — a fresh instance over the same dir sees the state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kcp-approvals-"));
    const first = new FileApprovalProvider(dir);
    const r = req();
    await first.submit(r);
    await first.resolve({ id: r.id, state: "approved", reviewer: "Kari N.", reviewedAt: new Date().toISOString(), policyRef: "POL-7.2" });

    const second = new FileApprovalProvider(dir);
    const status = await second.check(r.id);
    expect(status?.state).toBe("approved");
    expect(status?.resolution?.reviewer).toBe("Kari N.");
  });

  it("sees resolutions written by another instance (cross-process approval)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kcp-approvals-"));
    const proxySide = new FileApprovalProvider(dir);
    const r = req();
    await proxySide.submit(r);

    // A CLI in another process resolves it
    const cliSide = new FileApprovalProvider(dir);
    await cliSide.resolve({ id: r.id, state: "approved", reviewer: "Kari N.", reviewedAt: new Date().toISOString(), policyRef: "POL-7.2" });

    const status = await proxySide.check(r.id);
    expect(status?.state).toBe("approved");
  });
});

describe("newRequest", () => {
  it("assigns a unique id and requestedAt", () => {
    const a = req();
    const b = req();
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
    expect(Date.parse(a.requestedAt)).not.toBeNaN();
  });
});

describe("parseDuration", () => {
  it("parses hours, minutes, and days", () => {
    expect(parseDuration("72h")).toBe(72 * 3600_000);
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("7d")).toBe(7 * 24 * 3600_000);
  });

  it("throws on garbage", () => {
    expect(() => parseDuration("soon")).toThrow(/duration/i);
    expect(() => parseDuration("")).toThrow(/duration/i);
    expect(() => parseDuration("-5h")).toThrow(/duration/i);
  });
});

describe("latestForCall", () => {
  it("finds the most recent ticket for a (target, tool) pair", async () => {
    const p = new InMemoryApprovalProvider();
    const older = req();
    await p.submit(older);
    await p.resolve({ id: older.id, state: "dismissed", reviewer: "K", reviewedAt: new Date().toISOString(), policyRef: "P" });
    const newer = req();
    await p.submit(newer);
    const found = await latestForCall(p, "records/customer-7.md", "Write");
    expect(found?.request.id).toBe(newer.id);
  });

  it("returns undefined when nothing matches", async () => {
    const p = new InMemoryApprovalProvider();
    await p.submit(req());
    expect(await latestForCall(p, "docs/other.md", "Write")).toBeUndefined();
    expect(await latestForCall(p, "records/customer-7.md", "Read")).toBeUndefined();
  });
});

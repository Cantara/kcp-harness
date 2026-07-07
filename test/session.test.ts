import { describe, it, expect } from "vitest";
import {
  createSession,
  addPlan,
  isPathApproved,
  recordLoaded,
  getKnown,
  recordSpend,
  nextSequence,
} from "../src/session.js";
import type { AgentPlan, PlannedUnit } from "kcp-agent";

function makePlan(units: Array<{ id: string; path: string; score?: number }>): AgentPlan {
  return {
    task: "test task",
    manifest: { project: "test", version: "1.0" },
    trust: { requiresAttestation: false, agentCanAttest: false, note: "" },
    asOf: "2026-07-07",
    options: { capabilities: { role: "agent", paymentMethods: ["free"], credentials: [] }, maxUnits: 5, strict: false },
    selected: units.map((u) => ({
      id: u.id,
      path: u.path,
      intent: `intent for ${u.id}`,
      score: u.score ?? 10,
      reasons: ["test match"],
      payment: { method: "free", settled: true, cost: 0 },
      requiresAttestation: false,
      loadEligible: true,
    })) as PlannedUnit[],
    skipped: [],
    federation: [],
    budget: { projectedSpend: 0, currency: "USDC" },
    context: { approximate: false, unmeasured: 0, note: "" },
    warnings: [],
  } as unknown as AgentPlan;
}

describe("session", () => {
  it("creates a session with unique ID", () => {
    const s1 = createSession();
    const s2 = createSession();
    expect(s1.id).toBeTruthy();
    expect(s1.id).not.toBe(s2.id);
  });

  it("starts with empty state", () => {
    const s = createSession();
    expect(s.plans.size).toBe(0);
    expect(s.known.size).toBe(0);
    expect(s.budgetSpent).toBe(0);
    expect(s.sequence).toBe(0);
  });

  it("increments sequence monotonically", () => {
    const s = createSession();
    expect(nextSequence(s)).toBe(1);
    expect(nextSequence(s)).toBe(2);
    expect(nextSequence(s)).toBe(3);
  });

  it("registers and retrieves approved plans", () => {
    const s = createSession();
    const plan = makePlan([{ id: "api-docs", path: "docs/api.md" }]);
    addPlan(s, "./knowledge.yaml", "read api docs", plan);
    expect(s.plans.size).toBe(1);
    expect(s.plans.get("./knowledge.yaml")?.task).toBe("read api docs");
  });

  it("approves path in a registered plan", () => {
    const s = createSession();
    const plan = makePlan([
      { id: "api-docs", path: "docs/api.md" },
      { id: "guide", path: "docs/guide.md" },
    ]);
    addPlan(s, "./knowledge.yaml", "read docs", plan);

    const approved = isPathApproved(s, "docs/api.md");
    expect(approved).toBeTruthy();
    expect(approved?.task).toBe("read docs");
  });

  it("rejects path not in any plan", () => {
    const s = createSession();
    const plan = makePlan([{ id: "api-docs", path: "docs/api.md" }]);
    addPlan(s, "./knowledge.yaml", "read docs", plan);

    const approved = isPathApproved(s, "src/main.ts");
    expect(approved).toBeUndefined();
  });

  it("tracks known units for dedup", () => {
    const s = createSession();
    recordLoaded(s, "unit-1", "sha256-aaa");
    recordLoaded(s, "unit-2", "sha256-bbb");

    const known = getKnown(s);
    expect(known).toHaveLength(2);
    expect(known).toContainEqual({ id: "unit-1", sha256: "sha256-aaa" });
  });

  it("updates known unit sha on reload", () => {
    const s = createSession();
    recordLoaded(s, "unit-1", "sha256-old");
    recordLoaded(s, "unit-1", "sha256-new");

    const known = getKnown(s);
    expect(known).toHaveLength(1);
    expect(known[0].sha256).toBe("sha256-new");
  });

  it("tracks budget spend", () => {
    const s = createSession();
    recordSpend(s, 0.25);
    recordSpend(s, 0.10);
    expect(s.budgetSpent).toBeCloseTo(0.35);
  });
});

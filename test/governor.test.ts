import { describe, it, expect } from "vitest";
import { govern } from "../src/governor.js";
import { classify, type Classification } from "../src/classifier.js";
import { createSession, addPlan } from "../src/session.js";
import type { GovernancePolicy, GovernedDomain } from "../src/config.js";
import type { AgentPlan, PlannedUnit } from "kcp-agent";

const policy: GovernancePolicy = {
  fail_closed: true,
  audit_all: true,
  max_units: 5,
  strict: false,
};

function makePlan(units: Array<{ id: string; path: string }>): AgentPlan {
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
      score: 10,
      reasons: ["test"],
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

describe("governor", () => {
  it("passes through KCP tools", async () => {
    const session = createSession();
    const classification: Classification = { governed: true, reason: "KCP tool: kcp_plan" };
    const decision = await govern(classification, "kcp_plan", { task: "test", manifest: "." }, session, policy);
    expect(decision.approved).toBe(true);
    expect(decision.mode).toBe("kcp-passthrough");
  });

  it("passes through ungoverned calls", async () => {
    const session = createSession();
    const classification: Classification = { governed: false, reason: "not governed" };
    const decision = await govern(classification, "Bash", { command: "npm test" }, session, policy);
    expect(decision.approved).toBe(true);
    expect(decision.mode).toBe("kcp-passthrough");
  });

  it("approves via plan-first when path is in approved plan", async () => {
    const session = createSession();
    const plan = makePlan([{ id: "api-docs", path: "docs/api.md" }]);
    addPlan(session, "./knowledge.yaml", "read docs", plan);

    const domain: GovernedDomain = { manifest: "./knowledge.yaml", paths: ["docs/"] };
    const classification: Classification = {
      governed: true,
      domain,
      target: "docs/api.md",
      reason: "governed path",
    };

    const decision = await govern(classification, "Read", { file_path: "docs/api.md" }, session, policy);
    expect(decision.approved).toBe(true);
    expect(decision.mode).toBe("plan-first");
    expect(decision.approvedPlan?.task).toBe("read docs");
  });

  it("blocks when governed path is not in any plan and no manifest for auto-plan", async () => {
    const session = createSession();
    const domain: GovernedDomain = { manifest: "", paths: ["docs/"] };
    const classification: Classification = {
      governed: true,
      domain,
      target: "docs/secret.md",
      reason: "governed path",
    };

    const decision = await govern(classification, "Read", { file_path: "docs/secret.md" }, session, policy);
    // With empty manifest, auto-plan will fail → blocked
    expect(decision.approved).toBe(false);
    expect(decision.mode).toBe("blocked");
  });

  it("blocks when no target is extractable from governed call", async () => {
    const session = createSession();
    const domain: GovernedDomain = { manifest: "./knowledge.yaml", tools: ["custom_tool"] };
    const classification: Classification = {
      governed: true,
      domain,
      // No target — custom tool with no path/URL
      reason: "governed tool",
    };

    const decision = await govern(classification, "custom_tool", { query: "test" }, session, policy);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/no extractable target/);
  });
});

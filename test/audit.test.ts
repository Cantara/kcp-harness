import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemoryAuditLog,
  buildEvent,
  buildLifecycleEvent,
  buildBudgetEvent,
  buildDriftEvent,
  buildSkillEvent,
  type AuditEvent,
} from "../src/audit.js";
import type { Classification } from "../src/classifier.js";
import type { GovernanceDecision } from "../src/governor.js";
import type { DriftResult } from "../src/temporal-watch.js";

describe("InMemoryAuditLog", () => {
  let log: InMemoryAuditLog;

  beforeEach(() => {
    log = new InMemoryAuditLog();
  });

  it("starts empty", () => {
    expect(log.events).toEqual([]);
  });

  it("accumulates events", () => {
    const event = makeEvent("approved");
    log.emit(event);
    expect(log.events).toHaveLength(1);
    expect(log.events[0]).toBe(event);
  });

  it("preserves order", () => {
    const e1 = makeEvent("approved", 1);
    const e2 = makeEvent("blocked", 2);
    log.emit(e1);
    log.emit(e2);
    expect(log.events[0].sequence).toBe(1);
    expect(log.events[1].sequence).toBe(2);
  });

  it("reports :memory: as path", () => {
    expect(log.getPath()).toBe(":memory:");
  });
});

describe("buildEvent", () => {
  it("creates a well-formed audit event", () => {
    const classification: Classification = {
      governed: true,
      reason: "test reason",
      target: "docs/api.md",
    };
    const governance: GovernanceDecision = {
      approved: true,
      mode: "plan-first",
      reason: "approved by plan",
    };

    const event = buildEvent(
      "session-123",
      1,
      "Read",
      { file_path: "docs/api.md" },
      classification,
      governance,
      "approved",
      42,
    );

    expect(event.sessionId).toBe("session-123");
    expect(event.sequence).toBe(1);
    expect(event.type).toBe("tool_call");
    expect(event.toolCall!.name).toBe("Read");
    expect(event.classification!.governed).toBe(true);
    expect(event.governance?.approved).toBe(true);
    expect(event.outcome).toBe("approved");
    expect(event.durationMs).toBe(42);
    expect(event.timestamp).toBeTruthy();
  });

  it("redacts Write content", () => {
    const classification: Classification = { governed: false, reason: "pass" };
    const event = buildEvent(
      "s1",
      1,
      "Write",
      { file_path: "out.txt", content: "secret content here" },
      classification,
      undefined,
      "pass-through",
      10,
    );

    expect(event.toolCall!.args["content"]).toMatch(/\[\d+ chars redacted\]/);
  });

  it("redacts Bash password patterns", () => {
    const classification: Classification = { governed: false, reason: "pass" };
    const event = buildEvent(
      "s1",
      1,
      "Bash",
      { command: "curl -H 'api_key=sk-12345' https://api.example.com" },
      classification,
      undefined,
      "pass-through",
      10,
    );

    expect(event.toolCall!.args["command"]).toContain("[REDACTED]");
    expect(event.toolCall!.args["command"]).not.toContain("sk-12345");
  });

  it("records errors", () => {
    const classification: Classification = { governed: false, reason: "pass" };
    const event = buildEvent(
      "s1",
      1,
      "Read",
      {},
      classification,
      undefined,
      "error",
      5,
      "file not found",
    );

    expect(event.outcome).toBe("error");
    expect(event.error).toBe("file not found");
  });

  it("strips trace from governance decision", () => {
    const governance: GovernanceDecision = {
      approved: true,
      mode: "auto-plan",
      reason: "approved",
      trace: { task: "test", taskTerms: [], asOf: "2026-07-07", capabilities: {} as never, plan: {} as never, units: [], gateSummary: [] },
    };
    const classification: Classification = { governed: true, reason: "test" };

    const event = buildEvent("s1", 1, "Read", {}, classification, governance, "approved", 10);
    expect(event.governance?.trace).toBeUndefined();
  });
});

describe("buildLifecycleEvent", () => {
  it("creates session_start event", () => {
    const event = buildLifecycleEvent("s1", 1, "session_start", { domains: 2 });
    expect(event.type).toBe("session_start");
    expect(event.outcome).toBe("approved");
    expect(event.toolCall!.args["domains"]).toBe(2);
  });

  it("creates session_end event", () => {
    const event = buildLifecycleEvent("s1", 99, "session_end");
    expect(event.type).toBe("session_end");
    expect(event.sequence).toBe(99);
  });
});

describe("buildBudgetEvent", () => {
  it("creates accepted spend event", () => {
    const snapshot = { totals: { USDC: 0.25 }, remaining: 0.75, entryCount: 1, ceiling: { amount: 1, currency: "USDC" } };
    const event = buildBudgetEvent("s1", 5, true, snapshot, { amount: 0.25, currency: "USDC" });
    expect(event.type).toBe("budget_spend");
    expect(event.outcome).toBe("approved");
    expect(event.budget!.totals["USDC"]).toBeCloseTo(0.25);
    expect(event.budget!.remaining).toBeCloseTo(0.75);
  });

  it("creates rejected spend event", () => {
    const snapshot = { totals: { USDC: 0.90 }, remaining: 0.10, entryCount: 3, ceiling: { amount: 1, currency: "USDC" } };
    const event = buildBudgetEvent("s1", 6, false, snapshot);
    expect(event.type).toBe("budget_exceeded");
    expect(event.outcome).toBe("blocked");
  });
});

describe("buildDriftEvent", () => {
  it("creates temporal drift event", () => {
    const drift: DriftResult = {
      manifest: "./knowledge.yaml",
      task: "test",
      drifted: true,
      summary: "temporal drift detected: 1 unit(s) dropped",
      diff: {
        a: { project: "test", version: "1.0", task: "test", asOf: "2026-07-06" },
        b: { project: "test", version: "1.0", task: "test", asOf: "2026-07-07" },
        identical: false,
        moves: [{ id: "unit-1", direction: "selected_to_skipped", from: { score: 10 }, to: { reason: "expired" } }],
        scoreChanges: [],
        presence: [],
        budgetShifts: [],
        reasonChanges: [],
        warningChanges: { added: [], removed: [] },
      },
      checkedAt: new Date().toISOString(),
    };

    const event = buildDriftEvent("s1", 10, drift);
    expect(event.type).toBe("temporal_drift");
    expect(event.outcome).toBe("blocked");
    expect(event.drift!.manifest).toBe("./knowledge.yaml");
    expect(event.drift!.movedUnits).toBe(1);
    expect(event.drift!.newPlanAsOf).toBe("2026-07-07");
  });
});

describe("correlationId threading", () => {
  const classification: Classification = { governed: true, reason: "test" };

  it("stamps correlationId + parentId onto a tool_call event", () => {
    const event = buildEvent(
      "s1", 1, "Read", { file_path: "docs/api.md" }, classification, undefined,
      "approved", 10, undefined, "corr-1", "span-parent",
    );
    expect(event.correlationId).toBe("corr-1");
    expect(event.parentId).toBe("span-parent");
  });

  it("omits the fields entirely when no correlationId is supplied (backward-compatible)", () => {
    const event = buildEvent("s1", 1, "Read", {}, classification, undefined, "approved", 10);
    expect("correlationId" in event).toBe(false);
    expect("parentId" in event).toBe(false);
  });

  it("threads correlationId through the sibling builders", () => {
    const life = buildLifecycleEvent("s1", 1, "session_start", { domains: 1 }, "corr-2");
    expect(life.correlationId).toBe("corr-2");

    const budget = buildBudgetEvent("s1", 2, true,
      { totals: { USDC: 0 }, remaining: 1, entryCount: 0, ceiling: { amount: 1, currency: "USDC" } },
      undefined, "corr-2");
    expect(budget.correlationId).toBe("corr-2");
  });
});

describe("buildSkillEvent", () => {
  it("creates a skill_loaded event for an eligible skill", () => {
    const event = buildSkillEvent("s1", 7, true, {
      id: "deploy-skill",
      reason: "kind: skill with explicit eligibility grant",
      manifest: "./knowledge.yaml",
      actionScope: { tools: ["Bash"], paths: ["infra/"] },
    }, "corr-9");

    expect(event.type).toBe("skill_loaded");
    expect(event.outcome).toBe("approved");
    expect(event.skill!.id).toBe("deploy-skill");
    expect(event.skill!.eligible).toBe(true);
    expect(event.skill!.gate).toBe("skill_eligibility");
    expect(event.skill!.actionScope?.tools).toEqual(["Bash"]);
    expect(event.correlationId).toBe("corr-9");
  });

  it("creates a fail-closed skill_skipped event for an ineligible skill", () => {
    const event = buildSkillEvent("s1", 8, false, {
      id: "rotate-secrets-skill",
      reason: "kind: skill not invoke-eligible: no explicit eligibility grant",
    });
    expect(event.type).toBe("skill_skipped");
    expect(event.outcome).toBe("blocked");
    expect(event.skill!.eligible).toBe(false);
  });
});

function makeEvent(outcome: AuditEvent["outcome"], seq = 1): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId: "test-session",
    sequence: seq,
    type: "tool_call",
    toolCall: { name: "Read", args: { file_path: "docs/api.md" } },
    classification: { governed: true, reason: "test" },
    outcome,
    durationMs: 10,
  };
}

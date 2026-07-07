import { describe, it, expect } from "vitest";
import { BudgetLedger } from "../src/budget-ledger.js";

describe("BudgetLedger", () => {
  it("starts with zero totals", () => {
    const ledger = new BudgetLedger();
    expect(ledger.getTotal()).toBe(0);
    expect(ledger.getEntries()).toHaveLength(0);
  });

  it("records spend and updates running total", () => {
    const ledger = new BudgetLedger();
    const result = ledger.record(
      { manifest: "./knowledge.yaml", task: "test" },
      { amount: 0.25, currency: "USDC", method: "x402" },
    );
    expect(result.accepted).toBe(true);
    expect(result.total).toBeCloseTo(0.25);
    expect(ledger.getTotal("USDC")).toBeCloseTo(0.25);
    expect(ledger.getEntries()).toHaveLength(1);
  });

  it("accumulates multiple spends", () => {
    const ledger = new BudgetLedger();
    ledger.record(
      { manifest: "./a.yaml", task: "task1" },
      { amount: 0.25, currency: "USDC", method: "x402" },
    );
    ledger.record(
      { manifest: "./b.yaml", task: "task2" },
      { amount: 0.10, currency: "USDC", method: "x402" },
    );
    expect(ledger.getTotal("USDC")).toBeCloseTo(0.35);
    expect(ledger.getEntries()).toHaveLength(2);
  });

  it("tracks running total in each entry", () => {
    const ledger = new BudgetLedger();
    ledger.record(
      { manifest: "./a.yaml", task: "t1" },
      { amount: 0.25, currency: "USDC", method: "x402" },
    );
    const r2 = ledger.record(
      { manifest: "./b.yaml", task: "t2" },
      { amount: 0.10, currency: "USDC", method: "x402" },
    );
    expect(r2.entry?.runningTotal["USDC"]).toBeCloseTo(0.35);
  });

  it("tracks spend per currency independently", () => {
    const ledger = new BudgetLedger();
    ledger.record(
      { manifest: "./a.yaml", task: "t1" },
      { amount: 0.25, currency: "USDC", method: "x402" },
    );
    ledger.record(
      { manifest: "./b.yaml", task: "t2" },
      { amount: 100, currency: "JPY", method: "meter" },
    );
    expect(ledger.getTotal("USDC")).toBeCloseTo(0.25);
    expect(ledger.getTotal("JPY")).toBeCloseTo(100);
  });

  it("enforces ceiling and rejects over-budget spends", () => {
    const ledger = new BudgetLedger({ amount: 0.50, currency: "USDC" });
    const r1 = ledger.record(
      { manifest: "./a.yaml", task: "t1" },
      { amount: 0.25, currency: "USDC", method: "x402" },
    );
    expect(r1.accepted).toBe(true);
    expect(r1.remaining).toBeCloseTo(0.25);

    const r2 = ledger.record(
      { manifest: "./b.yaml", task: "t2" },
      { amount: 0.30, currency: "USDC", method: "x402" },
    );
    expect(r2.accepted).toBe(false);
    expect(r2.reason).toMatch(/exceed budget ceiling/);
    expect(ledger.getTotal("USDC")).toBeCloseTo(0.25); // unchanged
    expect(ledger.getEntries()).toHaveLength(1); // rejected entry not stored
  });

  it("allows spend exactly at ceiling", () => {
    const ledger = new BudgetLedger({ amount: 0.50, currency: "USDC" });
    ledger.record(
      { manifest: "./a.yaml", task: "t1" },
      { amount: 0.25, currency: "USDC", method: "x402" },
    );
    const r2 = ledger.record(
      { manifest: "./b.yaml", task: "t2" },
      { amount: 0.25, currency: "USDC", method: "x402" },
    );
    expect(r2.accepted).toBe(true);
    expect(r2.remaining).toBeCloseTo(0);
  });

  it("ceiling only applies to its own currency", () => {
    const ledger = new BudgetLedger({ amount: 0.50, currency: "USDC" });
    // JPY spend is uncapped
    const r = ledger.record(
      { manifest: "./a.yaml", task: "t1" },
      { amount: 99999, currency: "JPY", method: "meter" },
    );
    expect(r.accepted).toBe(true);
  });

  it("recordPlanSpend is a convenience for plan-level costs", () => {
    const ledger = new BudgetLedger({ amount: 1.00, currency: "USDC" });
    const r = ledger.recordPlanSpend("./knowledge.yaml", "test task", 0.50, "USDC", 42);
    expect(r.accepted).toBe(true);
    expect(r.entry?.source.manifest).toBe("./knowledge.yaml");
    expect(r.entry?.source.auditSequence).toBe(42);
    expect(r.entry?.cost.method).toBe("plan-projected");
  });

  it("recordUnitSpend tracks individual unit costs", () => {
    const ledger = new BudgetLedger();
    const r = ledger.recordUnitSpend("./knowledge.yaml", "chipfab-exclusive", "read article", 0.25, "USDC", "x402");
    expect(r.accepted).toBe(true);
    expect(r.entry?.source.unitId).toBe("chipfab-exclusive");
  });

  it("assigns monotonic sequence numbers", () => {
    const ledger = new BudgetLedger();
    ledger.record({ manifest: "a", task: "t" }, { amount: 0.1, currency: "USDC", method: "free" });
    ledger.record({ manifest: "b", task: "t" }, { amount: 0.1, currency: "USDC", method: "free" });
    const entries = ledger.getEntries();
    expect(entries[0].seq).toBe(1);
    expect(entries[1].seq).toBe(2);
  });

  it("snapshot returns current state", () => {
    const ledger = new BudgetLedger({ amount: 1.00, currency: "USDC" });
    ledger.record({ manifest: "a", task: "t" }, { amount: 0.25, currency: "USDC", method: "x402" });
    const snap = ledger.snapshot();
    expect(snap.ceiling?.amount).toBe(1.00);
    expect(snap.totals["USDC"]).toBeCloseTo(0.25);
    expect(snap.remaining).toBeCloseTo(0.75);
    expect(snap.entryCount).toBe(1);
    expect(snap.lastEntry?.seq).toBe(1);
  });

  it("snapshot with no entries", () => {
    const ledger = new BudgetLedger();
    const snap = ledger.snapshot();
    expect(snap.entryCount).toBe(0);
    expect(snap.lastEntry).toBeUndefined();
    expect(snap.remaining).toBeUndefined();
  });

  it("getRemaining returns undefined without ceiling", () => {
    const ledger = new BudgetLedger();
    expect(ledger.getRemaining()).toBeUndefined();
  });
});

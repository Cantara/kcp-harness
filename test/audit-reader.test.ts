import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AuditReader } from "../src/audit-reader.js";
import type { AuditEvent } from "../src/audit.js";

const TEST_DIR = join(import.meta.dirname ?? ".", ".tmp-audit-reader");
const LOG_PATH = join(TEST_DIR, "test.jsonl");

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    timestamp: "2026-07-07T10:00:00.000Z",
    sessionId: "sess-1",
    sequence: 1,
    type: "tool_call",
    outcome: "approved",
    durationMs: 5,
    ...overrides,
  };
}

function writeLog(events: AuditEvent[]): void {
  mkdirSync(TEST_DIR, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(LOG_PATH, lines, "utf-8");
}

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("AuditReader", () => {
  it("reads all events from JSONL", async () => {
    writeLog([makeEvent(), makeEvent({ sequence: 2 })]);
    const reader = new AuditReader(LOG_PATH);
    const events = await reader.readAll();
    expect(events).toHaveLength(2);
  });

  it("returns empty array for missing file", async () => {
    const reader = new AuditReader(join(TEST_DIR, "missing.jsonl"));
    const events = await reader.readAll();
    expect(events).toHaveLength(0);
  });

  it("skips malformed lines", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(LOG_PATH, `${JSON.stringify(makeEvent())}\nnot-json\n${JSON.stringify(makeEvent({ sequence: 2 }))}\n`);
    const reader = new AuditReader(LOG_PATH);
    const events = await reader.readAll();
    expect(events).toHaveLength(2);
  });

  it("filters by sessionId", async () => {
    writeLog([
      makeEvent({ sessionId: "a" }),
      makeEvent({ sessionId: "b" }),
      makeEvent({ sessionId: "a", sequence: 2 }),
    ]);
    const reader = new AuditReader(LOG_PATH);
    const events = await reader.readAll({ sessionId: "a" });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.sessionId === "a")).toBe(true);
  });

  it("filters by single type", async () => {
    writeLog([
      makeEvent({ type: "tool_call" }),
      makeEvent({ type: "session_start", sequence: 2 }),
      makeEvent({ type: "tool_call", sequence: 3 }),
    ]);
    const reader = new AuditReader(LOG_PATH);
    const events = await reader.readAll({ type: "session_start" });
    expect(events).toHaveLength(1);
  });

  it("filters by multiple types", async () => {
    writeLog([
      makeEvent({ type: "tool_call" }),
      makeEvent({ type: "session_start", sequence: 2 }),
      makeEvent({ type: "budget_exceeded", sequence: 3 }),
    ]);
    const reader = new AuditReader(LOG_PATH);
    const events = await reader.readAll({ type: ["session_start", "budget_exceeded"] });
    expect(events).toHaveLength(2);
  });

  it("filters by date range", async () => {
    writeLog([
      makeEvent({ timestamp: "2026-07-01T00:00:00Z" }),
      makeEvent({ timestamp: "2026-07-05T00:00:00Z", sequence: 2 }),
      makeEvent({ timestamp: "2026-07-10T00:00:00Z", sequence: 3 }),
    ]);
    const reader = new AuditReader(LOG_PATH);
    const events = await reader.readAll({ from: "2026-07-04", to: "2026-07-06" });
    expect(events).toHaveLength(1);
    expect(events[0].timestamp).toBe("2026-07-05T00:00:00Z");
  });

  it("filters by outcome", async () => {
    writeLog([
      makeEvent({ outcome: "approved" }),
      makeEvent({ outcome: "blocked", sequence: 2 }),
      makeEvent({ outcome: "approved", sequence: 3 }),
    ]);
    const reader = new AuditReader(LOG_PATH);
    const events = await reader.readAll({ outcome: "blocked" });
    expect(events).toHaveLength(1);
  });
});

describe("AuditReader.summarize", () => {
  it("produces correct summary statistics", async () => {
    writeLog([
      makeEvent({ sessionId: "a", type: "session_start", outcome: "approved" }),
      makeEvent({ sessionId: "a", type: "tool_call", outcome: "approved", classification: { governed: true, reason: "test" } as any, sequence: 2 }),
      makeEvent({ sessionId: "a", type: "tool_call", outcome: "blocked", classification: { governed: true, reason: "test" } as any, sequence: 3 }),
      makeEvent({ sessionId: "b", type: "tool_call", outcome: "approved", sequence: 4 }),
      makeEvent({ sessionId: "a", type: "budget_exceeded", outcome: "blocked", sequence: 5 }),
      makeEvent({ sessionId: "a", type: "temporal_drift", outcome: "blocked", sequence: 6 }),
    ]);
    const reader = new AuditReader(LOG_PATH);
    const summary = await reader.summarize();
    expect(summary.sessions).toBe(2);
    expect(summary.events).toBe(6);
    expect(summary.governed).toBe(2);
    expect(summary.blocked).toBe(3);
    expect(summary.budgetExceeded).toBe(1);
    expect(summary.drifts).toBe(1);
  });

  it("returns zeros for empty log", async () => {
    writeLog([]);
    const reader = new AuditReader(LOG_PATH);
    const summary = await reader.summarize();
    expect(summary.sessions).toBe(0);
    expect(summary.events).toBe(0);
  });
});

describe("AuditReader.sessionIndex", () => {
  it("indexes sessions correctly", async () => {
    writeLog([
      makeEvent({ sessionId: "a", type: "session_start", timestamp: "2026-07-07T09:00:00Z" }),
      makeEvent({ sessionId: "a", type: "tool_call", outcome: "blocked", timestamp: "2026-07-07T09:01:00Z", classification: { governed: true, reason: "test" } as any, sequence: 2 }),
      makeEvent({ sessionId: "a", type: "session_end", timestamp: "2026-07-07T09:02:00Z", sequence: 3 }),
      makeEvent({ sessionId: "b", type: "tool_call", timestamp: "2026-07-07T10:00:00Z", sequence: 4 }),
    ]);
    const reader = new AuditReader(LOG_PATH);
    const index = await reader.sessionIndex();
    expect(index.sessions).toHaveLength(2);

    const sessA = index.sessions.find((s) => s.id === "a");
    expect(sessA?.events).toBe(3);
    expect(sessA?.governed).toBe(1);
    expect(sessA?.blocked).toBe(1);
    expect(sessA?.endedAt).toBe("2026-07-07T09:02:00Z");

    const sessB = index.sessions.find((s) => s.id === "b");
    expect(sessB?.events).toBe(1);
  });
});

describe("AuditReader.chains / decisionChain", () => {
  it("groups events by correlation id, sorted by sequence", async () => {
    writeLog([
      makeEvent({ correlationId: "corr-A", type: "tool_call", sequence: 3 }),
      makeEvent({ correlationId: "corr-A", type: "approval_requested", sequence: 1 }),
      makeEvent({ correlationId: "corr-A", type: "confidence_verdict", sequence: 2 }),
      makeEvent({ correlationId: "corr-B", type: "tool_call", sequence: 4 }),
      makeEvent({ type: "session_start", sequence: 5 }), // no correlationId → omitted
    ]);
    const reader = new AuditReader(LOG_PATH);
    const chains = await reader.chains();

    expect(chains).toHaveLength(2);
    const a = chains.find((c) => c.correlationId === "corr-A")!;
    expect(a.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(a.events.map((e) => e.type)).toEqual([
      "approval_requested",
      "confidence_verdict",
      "tool_call",
    ]);
  });

  it("reconstructs a single chain and flags blocked", async () => {
    writeLog([
      makeEvent({ correlationId: "corr-X", type: "tool_call", outcome: "approved", sequence: 1 }),
      makeEvent({ correlationId: "corr-X", type: "skill_skipped", outcome: "blocked", sequence: 2 }),
      makeEvent({ correlationId: "corr-Y", type: "tool_call", outcome: "approved", sequence: 3 }),
    ]);
    const reader = new AuditReader(LOG_PATH);

    const x = await reader.decisionChain("corr-X");
    expect(x).toBeDefined();
    expect(x!.events).toHaveLength(2);
    expect(x!.blocked).toBe(true);

    const y = await reader.decisionChain("corr-Y");
    expect(y!.blocked).toBe(false);

    expect(await reader.decisionChain("nope")).toBeUndefined();
  });

  it("carries the W3C parent span-id onto the chain", async () => {
    writeLog([
      makeEvent({ correlationId: "corr-P", parentId: "00f067aa0ba902b7", sequence: 1 }),
      makeEvent({ correlationId: "corr-P", sequence: 2 }),
    ]);
    const reader = new AuditReader(LOG_PATH);
    const p = await reader.decisionChain("corr-P");
    expect(p!.parentId).toBe("00f067aa0ba902b7");
  });
});

describe("AuditReader metadata", () => {
  it("reports existence correctly", () => {
    writeLog([makeEvent()]);
    const reader = new AuditReader(LOG_PATH);
    expect(reader.exists()).toBe(true);

    const missing = new AuditReader(join(TEST_DIR, "nope.jsonl"));
    expect(missing.exists()).toBe(false);
  });

  it("reports file size", () => {
    writeLog([makeEvent()]);
    const reader = new AuditReader(LOG_PATH);
    expect(reader.size()).toBeGreaterThan(0);
  });
});

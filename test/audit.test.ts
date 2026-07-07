import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryAuditLog, buildEvent, type AuditEvent } from "../src/audit.js";
import type { Classification } from "../src/classifier.js";
import type { GovernanceDecision } from "../src/governor.js";

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
    expect(event.toolCall.name).toBe("Read");
    expect(event.classification.governed).toBe(true);
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

    expect(event.toolCall.args["content"]).toMatch(/\[\d+ chars redacted\]/);
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

    expect(event.toolCall.args["command"]).toContain("[REDACTED]");
    expect(event.toolCall.args["command"]).not.toContain("sk-12345");
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

function makeEvent(outcome: AuditEvent["outcome"], seq = 1): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId: "test-session",
    sequence: seq,
    toolCall: { name: "Read", args: { file_path: "docs/api.md" } },
    classification: { governed: true, reason: "test" },
    outcome,
    durationMs: 10,
  };
}

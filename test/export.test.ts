import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exportEvidence } from "../src/export.js";
import type { AuditEvent } from "../src/audit.js";

const TEST_DIR = join(import.meta.dirname ?? ".", ".tmp-export");
const LOG_PATH = join(TEST_DIR, "audit.jsonl");
const OUT_DIR = join(TEST_DIR, "evidence");

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

function readJSON(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("exportEvidence", () => {
  it("exports SOC 2 evidence", async () => {
    writeLog([
      makeEvent({ type: "session_start", outcome: "approved" }),
      makeEvent({
        type: "tool_call",
        outcome: "approved",
        classification: { governed: true, reason: "governed path" },
        governance: { approved: true, mode: "auto-plan", reason: "approved" } as any,
        sequence: 2,
      }),
      makeEvent({
        type: "tool_call",
        outcome: "blocked",
        classification: { governed: true, reason: "governed path" },
        governance: { approved: false, mode: "blocked", reason: "unsigned" } as any,
        sequence: 3,
      }),
    ]);

    const result = await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "soc2",
      organization: "Test Corp",
    });

    expect(result.files).toContain("manifest.json");
    expect(result.files).toContain("soc2/CC6.1-logical-access.json");
    expect(result.files).toContain("soc2/CC6.6-system-boundaries.json");
    expect(result.files).toContain("soc2/CC7.2-monitoring.json");
    expect(result.files).toContain("soc2/CC8.1-change-management.json");
    expect(result.files).toContain("soc2/summary.md");

    // Verify manifest
    const manifest = readJSON(join(OUT_DIR, "manifest.json")) as any;
    expect(manifest.generator).toBe("kcp-harness");
    expect(manifest.organization).toBe("Test Corp");
    expect(manifest.format).toBe("soc2");
    expect(manifest.statistics.events).toBe(3);
  });

  it("exports ISO 27001 evidence", async () => {
    writeLog([
      makeEvent({
        type: "tool_call",
        outcome: "approved",
        classification: { governed: true, reason: "governed path" },
        toolCall: { name: "Read", args: { file_path: "src/main.ts" } },
      }),
    ]);

    const result = await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "iso27001",
    });

    expect(result.files).toContain("iso27001/A.8.3-access-restriction.json");
    expect(result.files).toContain("iso27001/A.8.4-source-code-access.json");
    expect(result.files).toContain("iso27001/A.8.15-logging.json");
    expect(result.files).toContain("iso27001/A.8.16-monitoring.json");
    expect(result.files).toContain("iso27001/A.5.23-cloud-services.json");
    expect(result.files).toContain("iso27001/summary.md");
  });

  it("exports both formats", async () => {
    writeLog([makeEvent()]);

    const result = await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "both",
    });

    expect(result.files.some((f) => f.startsWith("soc2/"))).toBe(true);
    expect(result.files.some((f) => f.startsWith("iso27001/"))).toBe(true);
  });

  it("includes raw session and statistics data", async () => {
    writeLog([makeEvent()]);

    const result = await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "soc2",
    });

    expect(result.files).toContain("raw/sessions.json");
    expect(result.files).toContain("raw/statistics.json");

    const stats = readJSON(join(OUT_DIR, "raw/statistics.json")) as any;
    expect(stats.events).toBe(1);
    expect(stats.sessions).toBe(1);
  });

  it("filters by date range", async () => {
    writeLog([
      makeEvent({ timestamp: "2026-07-01T00:00:00Z" }),
      makeEvent({ timestamp: "2026-07-05T00:00:00Z", sequence: 2 }),
      makeEvent({ timestamp: "2026-07-10T00:00:00Z", sequence: 3 }),
    ]);

    const result = await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "soc2",
      dateRange: { from: "2026-07-04", to: "2026-07-06" },
    });

    expect(result.summary.events).toBe(1);
  });

  it("maps governed events to CC6.1", async () => {
    writeLog([
      makeEvent({
        type: "tool_call",
        outcome: "blocked",
        classification: { governed: true, reason: "governed path" },
        governance: { approved: false, mode: "blocked", reason: "blocked" } as any,
      }),
      makeEvent({
        type: "tool_call",
        outcome: "approved",
        classification: { governed: false, reason: "not governed" },
        sequence: 2,
      }),
    ]);

    await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "soc2",
    });

    const cc61 = readJSON(join(OUT_DIR, "soc2/CC6.1-logical-access.json")) as any;
    // Only the governed event should be in CC6.1
    expect(cc61.evidenceCount).toBe(1);
    expect(cc61.controlId).toBe("CC6.1");
  });

  it("maps temporal drift to CC8.1", async () => {
    writeLog([
      makeEvent({
        type: "temporal_drift",
        outcome: "blocked",
        drift: { manifest: "./k.yaml", summary: "units moved", movedUnits: 2 },
      }),
    ]);

    await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "soc2",
    });

    const cc81 = readJSON(join(OUT_DIR, "soc2/CC8.1-change-management.json")) as any;
    expect(cc81.evidenceCount).toBe(1);
    expect(cc81.events[0].detail).toMatch(/drift/);
  });

  it("maps signature events to A.5.23", async () => {
    writeLog([
      makeEvent({
        type: "tool_call",
        outcome: "blocked",
        signature: { status: "unsigned", detail: "no signing block" },
      }),
      makeEvent({
        type: "tool_call",
        outcome: "approved",
        signature: { status: "verified", detail: "Ed25519 OK", keyId: "k1" },
        sequence: 2,
      }),
    ]);

    await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "iso27001",
    });

    const a523 = readJSON(join(OUT_DIR, "iso27001/A.5.23-cloud-services.json")) as any;
    expect(a523.evidenceCount).toBe(2);
  });

  // #33 — approval_resolved and confidence_verdict are the strongest human-
  // oversight evidence the harness produces; they were missing from SOC2/
  // ISO27001 export entirely, even though the live demo dashboard's tallyControls()
  // claims (falsely) to mirror these exact predicates.
  it("maps approval_resolved (named-human authorization) to SOC2 CC6.3", async () => {
    writeLog([
      makeEvent({
        type: "approval_resolved",
        outcome: "approved",
        approval: { id: "t1", state: "approved", reviewer: "bob", policyRef: "POL-7.2" },
      }),
      makeEvent({ type: "tool_call", outcome: "approved", sequence: 2 }),
    ]);

    await exportEvidence({ auditPath: LOG_PATH, outputDir: OUT_DIR, format: "soc2" });

    const cc63 = readJSON(join(OUT_DIR, "soc2/CC6.3-authorized-access.json")) as any;
    expect(cc63.evidenceCount).toBe(1);
    expect(cc63.events[0].detail).toMatch(/bob/);
  });

  it("maps approval_requested and confidence_verdict to ISO27001 A.8.16 — including PASSING verdicts", async () => {
    // The generic `outcome === "blocked"` clause already caught a failed/held
    // verdict by accident. The real gap: a confidence_verdict that CLEARED
    // the threshold (outcome: "approved") is itself monitoring evidence —
    // every adjudication run is evidence, not just the ones that held.
    writeLog([
      makeEvent({
        type: "approval_requested",
        outcome: "blocked",
        approval: { id: "t1", state: "pending", requiredRole: "lead", toolName: "Bash" },
      }),
      makeEvent({
        type: "confidence_verdict",
        outcome: "approved",
        confidence: { task: "answer", passed: true, score: 0.9, threshold: 0.8, detail: "cleared" },
        sequence: 2,
      }),
      makeEvent({ type: "tool_call", outcome: "approved", sequence: 3 }),
    ]);

    await exportEvidence({ auditPath: LOG_PATH, outputDir: OUT_DIR, format: "iso27001" });

    const a816 = readJSON(join(OUT_DIR, "iso27001/A.8.16-monitoring.json")) as any;
    expect(a816.evidenceCount).toBe(2);
  });

  it("generates Markdown summary reports", async () => {
    writeLog([makeEvent()]);

    await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "both",
      organization: "Acme Corp",
    });

    const soc2Summary = readFileSync(join(OUT_DIR, "soc2/summary.md"), "utf-8");
    expect(soc2Summary).toContain("SOC 2 Type II");
    expect(soc2Summary).toContain("Acme Corp");
    expect(soc2Summary).toContain("CC6.1");

    const isoSummary = readFileSync(join(OUT_DIR, "iso27001/summary.md"), "utf-8");
    expect(isoSummary).toContain("ISO 27001 Annex A");
    expect(isoSummary).toContain("A.8.3");
  });

  it("handles empty audit log", async () => {
    writeLog([]);

    const result = await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "both",
    });

    expect(result.summary.events).toBe(0);
    expect(result.files.length).toBeGreaterThan(0);
  });

  it("maps Read/Glob/Grep to A.8.4 source code access", async () => {
    writeLog([
      makeEvent({
        type: "tool_call",
        outcome: "approved",
        classification: { governed: true, reason: "path" },
        toolCall: { name: "Read", args: { file_path: "src/main.ts" } },
      }),
      makeEvent({
        type: "tool_call",
        outcome: "approved",
        classification: { governed: true, reason: "path" },
        toolCall: { name: "Glob", args: { pattern: "src/**" } },
        sequence: 2,
      }),
      makeEvent({
        type: "tool_call",
        outcome: "approved",
        classification: { governed: true, reason: "path" },
        toolCall: { name: "Bash", args: { command: "npm test" } },
        sequence: 3,
      }),
    ]);

    await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "iso27001",
    });

    const a84 = readJSON(join(OUT_DIR, "iso27001/A.8.4-source-code-access.json")) as any;
    // Read and Glob match, Bash does not
    expect(a84.evidenceCount).toBe(2);
  });

  it("exports ISO/IEC 42001 evidence", async () => {
    writeLog([
      makeEvent({ type: "session_start", outcome: "approved" }),
      makeEvent({
        type: "tool_call",
        outcome: "approved",
        classification: { governed: true, reason: "governed path" },
        sequence: 2,
      }),
      makeEvent({
        type: "approval_resolved",
        outcome: "approved",
        approval: { id: "t1", state: "approved", reviewer: "alice", requiredRole: "lead" },
        sequence: 3,
      }),
      makeEvent({
        type: "confidence_verdict",
        outcome: "blocked",
        confidence: { task: "answer", passed: false, score: 0.4, threshold: 0.8, detail: "low" },
        sequence: 4,
      }),
    ]);

    const result = await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "iso42001",
      organization: "AI Corp",
    });

    expect(result.files).toContain("iso42001/A.6.2.6-operation-monitoring.json");
    expect(result.files).toContain("iso42001/A.6.2.8-event-logs.json");
    expect(result.files).toContain("iso42001/A.9.2-responsible-use.json");
    expect(result.files).toContain("iso42001/A.9.4-human-oversight.json");
    expect(result.files).toContain("iso42001/A.6.2.4-verification-validation.json");
    expect(result.files).toContain("iso42001/summary.md");

    const manifest = readJSON(join(OUT_DIR, "manifest.json")) as any;
    expect(manifest.format).toBe("iso42001");

    const summary = readFileSync(join(OUT_DIR, "iso42001/summary.md"), "utf-8");
    expect(summary).toContain("ISO/IEC 42001");
    expect(summary).toContain("AI Corp");
    expect(summary).toContain("A.9.4");
  });

  it("maps governed tool calls to ISO 42001 A.9.2 responsible use", async () => {
    writeLog([
      makeEvent({
        type: "tool_call",
        outcome: "approved",
        classification: { governed: true, reason: "governed path" },
      }),
      makeEvent({
        type: "tool_call",
        outcome: "approved",
        classification: { governed: false, reason: "pass-through" },
        sequence: 2,
      }),
    ]);

    await exportEvidence({ auditPath: LOG_PATH, outputDir: OUT_DIR, format: "iso42001" });

    const a92 = readJSON(join(OUT_DIR, "iso42001/A.9.2-responsible-use.json")) as any;
    expect(a92.evidenceCount).toBe(1);
    expect(a92.controlId).toBe("A.9.2");
  });

  it("maps approval events to ISO 42001 A.9.4 human oversight", async () => {
    writeLog([
      makeEvent({
        type: "approval_requested",
        outcome: "blocked",
        approval: { id: "t1", state: "pending", requiredRole: "lead", toolName: "Bash" },
      }),
      makeEvent({
        type: "approval_resolved",
        outcome: "approved",
        approval: { id: "t1", state: "approved", reviewer: "bob" },
        sequence: 2,
      }),
      makeEvent({ type: "tool_call", outcome: "approved", sequence: 3 }),
    ]);

    await exportEvidence({ auditPath: LOG_PATH, outputDir: OUT_DIR, format: "iso42001" });

    const a94 = readJSON(join(OUT_DIR, "iso42001/A.9.4-human-oversight.json")) as any;
    expect(a94.evidenceCount).toBe(2);
    expect(a94.events[1].detail).toMatch(/bob/);
  });

  it("exports EU AI Act evidence", async () => {
    writeLog([
      makeEvent({ type: "session_start", outcome: "approved" }),
      makeEvent({
        type: "approval_resolved",
        outcome: "approved",
        approval: { id: "t1", state: "approved", reviewer: "alice" },
        sequence: 2,
      }),
      makeEvent({
        type: "confidence_verdict",
        outcome: "blocked",
        confidence: { task: "answer", passed: false, score: 0.4, threshold: 0.8, detail: "low", ticketId: "TIK-9" },
        sequence: 3,
      }),
    ]);

    const result = await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "euaiact",
      organization: "AI Corp",
    });

    expect(result.files).toContain("eu-ai-act/Art.12-1-automatic-logging.json");
    expect(result.files).toContain("eu-ai-act/Art.12-2-traceability.json");
    expect(result.files).toContain("eu-ai-act/Art.14-1-approval-gates.json");
    expect(result.files).toContain("eu-ai-act/Art.14-4-intervention-stop.json");
    expect(result.files).toContain("eu-ai-act/Art.14-4c-output-interpretation.json");
    expect(result.files).toContain("eu-ai-act/summary.md");

    const manifest = readJSON(join(OUT_DIR, "manifest.json")) as any;
    expect(manifest.format).toBe("euaiact");

    const summary = readFileSync(join(OUT_DIR, "eu-ai-act/summary.md"), "utf-8");
    expect(summary).toContain("EU AI Act");
    expect(summary).toContain("Art.12(1)");
    expect(summary).toContain("Art.14(1)");
  });

  it("maps the whole append-only log to EU AI Act Art. 12(1)", async () => {
    writeLog([
      makeEvent({ type: "session_start", outcome: "approved" }),
      makeEvent({ type: "tool_call", outcome: "approved", sequence: 2 }),
      makeEvent({ type: "budget_spend", outcome: "approved", sequence: 3 }),
    ]);

    await exportEvidence({ auditPath: LOG_PATH, outputDir: OUT_DIR, format: "euaiact" });

    const art12 = readJSON(join(OUT_DIR, "eu-ai-act/Art.12-1-automatic-logging.json")) as any;
    // Article 12(1) captures every event in the append-only log.
    expect(art12.evidenceCount).toBe(3);
    expect(art12.controlId).toBe("Art.12(1)");
  });

  it("maps approval gates to EU AI Act Art. 14(1) and stops to Art. 14(4)", async () => {
    writeLog([
      makeEvent({
        type: "approval_requested",
        outcome: "blocked",
        approval: { id: "t1", state: "pending", requiredRole: "lead" },
      }),
      makeEvent({
        type: "budget_exceeded",
        outcome: "blocked",
        sequence: 2,
      }),
      makeEvent({
        type: "tool_call",
        outcome: "blocked",
        classification: { governed: true, reason: "policy" },
        sequence: 3,
      }),
    ]);

    await exportEvidence({ auditPath: LOG_PATH, outputDir: OUT_DIR, format: "euaiact" });

    const art14gate = readJSON(join(OUT_DIR, "eu-ai-act/Art.14-1-approval-gates.json")) as any;
    expect(art14gate.evidenceCount).toBe(1);

    const art14stop = readJSON(join(OUT_DIR, "eu-ai-act/Art.14-4-intervention-stop.json")) as any;
    // Every blocked call is a halt/intervention record: pending approval_requested
    // (outcome "blocked"), budget_exceeded, and the blocked tool_call = 3.
    expect(art14stop.evidenceCount).toBe(3);
  });
});

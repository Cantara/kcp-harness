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
});

// #37's export is the artifact an auditor actually reads. It dropped the correlation id, so
// an exported event could not be traced back to the decision chain that produced it — the
// verdict cascade for that action, and the planner/runtime records sharing its trace.
//
// "Compliance as a side effect of normal operation" only holds if the exported evidence is
// still connected to the operation.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { exportEvidence } from "../src/export.js";
import { deriveCorrelation } from "../src/correlation.js";
import type { AuditEvent } from "../src/audit.js";

const TEST_DIR = join(import.meta.dirname ?? ".", ".tmp-export-corr");
const LOG_PATH = join(TEST_DIR, "audit.jsonl");
const OUT_DIR = join(TEST_DIR, "out");

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const STORED = deriveCorrelation({ traceparent: TRACEPARENT }).correlationId;

const event = (o: Partial<AuditEvent> = {}): AuditEvent => ({
  timestamp: "2026-07-07T10:00:00.000Z",
  sessionId: "sess-1",
  sequence: 1,
  type: "tool_call",
  outcome: "approved",
  durationMs: 5,
  ...o,
});

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(
    LOG_PATH,
    [
      event({ sequence: 1, correlationId: STORED, classification: { governed: true } as never }),
      event({ sequence: 2 }),
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
    "utf-8",
  );
});
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

/** Every JSON file the export wrote, at any depth — it writes into per-format subdirectories. */
function exportedJsonFiles(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) out.push({ file: full, text: readFileSync(full, "utf-8") });
    }
  };
  walk(OUT_DIR);
  return out;
}

function exportedJson(): string {
  return exportedJsonFiles().map((f) => f.text).join("\n");
}

describe("exported evidence carries the correlation id", () => {
  it("includes it on events that have one", async () => {
    await exportEvidence({ auditPath: LOG_PATH, outputDir: OUT_DIR, format: "iso42001" });
    const json = exportedJson();
    expect(json.length, "the export produced no JSON").toBeGreaterThan(0);
    expect(json, "an exported event must be traceable to its decision chain").toContain(STORED);
  });

  // An event without a correlation id must not gain an empty or invented one: a blank field
  // reads as "not correlated" and an invented one is a false claim in an audit artifact.
  it("omits the field entirely for events that have none", async () => {
    await exportEvidence({ auditPath: LOG_PATH, outputDir: OUT_DIR, format: "iso42001" });
    for (const { file, text } of exportedJsonFiles()) {
      const parsed = JSON.parse(text);
      for (const evidence of findEvents(parsed)) {
        if (!("correlationId" in evidence)) continue;
        expect(evidence.correlationId, `${file}: empty correlationId written`).toBeTruthy();
      }
    }
  });
});

/** Walk an exported document for anything shaped like an evidence event. */
function findEvents(node: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      if ("timestamp" in o && "outcome" in o) out.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(node);
  return out;
}

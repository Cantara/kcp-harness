// Audit hash-chain — tamper-evident continuity of the append-only log.
//
// Each entry commits to the sha256 of the previous entry's canonical bytes
// (prevHash), so the JSONL log is a hash chain: an end-to-end verify passes on
// an untouched log, and any tampered field or reordered entry is detectable
// without trusting the storage medium. This is the gap these tests capture —
// on main, entries carry a sequence number but no cryptographic linkage.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuditLog,
  InMemoryAuditLog,
  buildLifecycleEvent,
  buildEvent,
  verifyAuditChain,
  GENESIS_HASH,
  hashAuditEntry,
  type AuditEvent,
} from "../src/audit.js";
import type { Classification } from "../src/classifier.js";

const TEST_DIR = join(import.meta.dirname ?? ".", ".tmp-audit-chain");
const LOG_PATH = join(TEST_DIR, "audit.jsonl");

const CLASSIFICATION: Classification = { governed: true, reason: "governed path", target: "docs/a.md" };

function toolCall(seq: number): AuditEvent {
  return buildEvent("sess-1", seq, "Read", { file_path: `docs/${seq}.md` }, CLASSIFICATION, undefined, "approved", 1);
}

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("audit hash-chain — emit", () => {
  it("stamps the genesis entry's prevHash with the genesis constant", () => {
    const log = new InMemoryAuditLog();
    log.emit(buildLifecycleEvent("sess-1", 1, "session_start"));
    expect(log.events[0].prevHash).toBe(GENESIS_HASH);
  });

  it("links each entry to the sha256 of the previous entry's canonical bytes", () => {
    const log = new InMemoryAuditLog();
    log.emit(buildLifecycleEvent("sess-1", 1, "session_start"));
    log.emit(toolCall(2));
    log.emit(toolCall(3));

    expect(log.events[1].prevHash).toBe(hashAuditEntry(log.events[0]));
    expect(log.events[2].prevHash).toBe(hashAuditEntry(log.events[1]));
  });
});

describe("audit hash-chain — verify", () => {
  it("verifies an untouched in-memory chain end to end", () => {
    const log = new InMemoryAuditLog();
    log.emit(buildLifecycleEvent("sess-1", 1, "session_start"));
    log.emit(toolCall(2));
    log.emit(toolCall(3));
    log.emit(buildLifecycleEvent("sess-1", 4, "session_end"));

    const result = verifyAuditChain(log.events);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it("verifies an untouched chain persisted to and re-read from the JSONL file", () => {
    const log = new AuditLog(LOG_PATH);
    log.emit(buildLifecycleEvent("sess-1", 1, "session_start"));
    log.emit(toolCall(2));
    log.emit(toolCall(3));

    const events = readLog(LOG_PATH);
    expect(events).toHaveLength(3);
    expect(verifyAuditChain(events).valid).toBe(true);
  });

  it("continues the chain across writer restarts (seeds prevHash from the file tail)", () => {
    const first = new AuditLog(LOG_PATH);
    first.emit(buildLifecycleEvent("sess-1", 1, "session_start"));
    first.emit(toolCall(2));

    // A brand-new writer over the same file must pick up where the chain left off.
    const second = new AuditLog(LOG_PATH);
    second.emit(toolCall(3));

    const events = readLog(LOG_PATH);
    expect(events).toHaveLength(3);
    expect(verifyAuditChain(events).valid).toBe(true);
    expect(events[2].prevHash).toBe(hashAuditEntry(events[1]));
  });

  it("DETECTS a tampered field in a non-terminal entry", () => {
    const log = new InMemoryAuditLog();
    log.emit(buildLifecycleEvent("sess-1", 1, "session_start"));
    log.emit(toolCall(2));
    log.emit(toolCall(3));

    // Auditor-grade attack: flip an outcome on an already-chained entry.
    const forged = log.events.map((e) => ({ ...e }));
    forged[1].outcome = "blocked";

    const result = verifyAuditChain(forged);
    expect(result.valid).toBe(false);
    // The break surfaces at the successor whose prevHash no longer matches.
    expect(result.brokenAt).toBe(2);
  });

  it("DETECTS reordered entries", () => {
    const log = new InMemoryAuditLog();
    log.emit(buildLifecycleEvent("sess-1", 1, "session_start"));
    log.emit(toolCall(2));
    log.emit(toolCall(3));

    const reordered = [log.events[0], log.events[2], log.events[1]].map((e) => ({ ...e }));
    const result = verifyAuditChain(reordered);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it("DETECTS tampering of a persisted JSONL entry", () => {
    const log = new AuditLog(LOG_PATH);
    log.emit(buildLifecycleEvent("sess-1", 1, "session_start"));
    log.emit(toolCall(2));
    log.emit(toolCall(3));

    // Rewrite the middle line with a forged outcome, leaving the chain links intact.
    const lines = readFileSync(LOG_PATH, "utf-8").trimEnd().split("\n");
    const middle = JSON.parse(lines[1]) as AuditEvent;
    middle.outcome = "blocked";
    lines[1] = JSON.stringify(middle);
    writeFileSync(LOG_PATH, lines.join("\n") + "\n", "utf-8");

    const events = readLog(LOG_PATH);
    expect(verifyAuditChain(events).valid).toBe(false);
  });
});

function readLog(path: string): AuditEvent[] {
  return readFileSync(path, "utf-8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEvent);
}

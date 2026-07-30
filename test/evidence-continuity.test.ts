// Cryptographic-continuity of the signed evidence (evidence-crypto-continuity).
//
// Verifies the three continuity guarantees the harness previously lacked:
//   (a) the JSONL audit log is hash-chained (prevHash), so a tampered or
//       reordered entry is detectable;
//   (b) a decision trace is Ed25519-signed and verifies with the public key;
//   (c) the compliance export bundle is Ed25519-signed and commits to the
//       audit chain head, so the whole bundle is tamper-evident.
//
// All signing reuses the single Ed25519 mechanism in resolution-signature.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  InMemoryAuditLog,
  AuditLog,
  buildEvent,
  buildLifecycleEvent,
  type AuditEvent,
} from "../src/audit.js";
import { verifyAuditChain, GENESIS_HASH, hashAuditLine } from "../src/audit-chain.js";
import { AuditReader } from "../src/audit-reader.js";
import { toTraceEvent, signTraceEvent, verifyTraceEvent } from "../src/trace-emit.js";
import { signDetached, verifyDetached } from "../src/resolution-signature.js";
import { exportEvidence } from "../src/export.js";
import type { Classification } from "../src/classifier.js";
import type { DecisionTrace } from "kcp-agent";

function newKeypair(): { privatePem: string; publicPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const GOVERNED: Classification = { governed: true, reason: "governed path" };

// -- (a) audit hash-chaining --------------------------------------------------

describe("audit log hash-chaining", () => {
  it("stamps GENESIS as the first entry's prevHash and links each subsequent entry", () => {
    const log = new InMemoryAuditLog();
    log.emit(buildLifecycleEvent("s1", 1, "session_start"));
    log.emit(buildEvent("s1", 2, "Read", { file_path: "docs/a.md" }, GOVERNED, undefined, "approved", 5));
    log.emit(buildEvent("s1", 3, "Read", { file_path: "docs/b.md" }, GOVERNED, undefined, "approved", 5));

    expect(log.events[0].prevHash).toBe(GENESIS_HASH);
    // Each entry's prevHash equals the sha256 of the previous entry's canonical line.
    const lines = log.lines();
    expect(log.events[1].prevHash).toBe(hashAuditLine(lines[0]));
    expect(log.events[2].prevHash).toBe(hashAuditLine(lines[1]));
  });

  it("verifies an intact chain end-to-end", () => {
    const log = new InMemoryAuditLog();
    for (let i = 1; i <= 5; i++) {
      log.emit(buildEvent("s1", i, "Read", { file_path: `docs/${i}.md` }, GOVERNED, undefined, "approved", 5));
    }
    const result = verifyAuditChain(log.lines());
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(5);
    expect(result.headHash).toHaveLength(64);
  });

  it("DETECTS a tampered entry", () => {
    const log = new InMemoryAuditLog();
    for (let i = 1; i <= 4; i++) {
      log.emit(buildEvent("s1", i, "Read", { file_path: `docs/${i}.md` }, GOVERNED, undefined, "approved", 5));
    }
    const lines = log.lines();
    // An auditor-invisible edit: flip a blocked outcome to approved on entry #2.
    const tampered = JSON.parse(lines[1]) as AuditEvent;
    tampered.outcome = "blocked";
    lines[1] = JSON.stringify(tampered);

    const result = verifyAuditChain(lines);
    expect(result.valid).toBe(false);
    // The break surfaces at the NEXT link, whose prevHash no longer matches.
    expect(result.brokenAt).toBe(2);
  });

  it("DETECTS reordered entries", () => {
    const log = new InMemoryAuditLog();
    for (let i = 1; i <= 4; i++) {
      log.emit(buildEvent("s1", i, "Read", { file_path: `docs/${i}.md` }, GOVERNED, undefined, "approved", 5));
    }
    const lines = log.lines();
    [lines[1], lines[2]] = [lines[2], lines[1]];
    const result = verifyAuditChain(lines);
    expect(result.valid).toBe(false);
  });

  it("chains across a file-backed writer and verifies through the reader", async () => {
    const dir = join(import.meta.dirname ?? ".", ".tmp-chain");
    const path = join(dir, "audit.jsonl");
    mkdirSync(dir, { recursive: true });
    try {
      const log = new AuditLog(path);
      log.emit(buildLifecycleEvent("s1", 1, "session_start"));
      log.emit(buildEvent("s1", 2, "Read", { file_path: "docs/a.md" }, GOVERNED, undefined, "approved", 5));
      log.emit(buildEvent("s1", 3, "Write", { file_path: "docs/b.md" }, GOVERNED, undefined, "blocked", 5));

      const reader = new AuditReader(path);
      const result = await reader.verifyChain();
      expect(result.valid).toBe(true);
      expect(result.entries).toBe(3);

      // Tamper the file directly and re-verify → detected.
      const raw = readFileSync(path, "utf-8").split("\n").filter(Boolean);
      const ev = JSON.parse(raw[0]) as AuditEvent;
      ev.sessionId = "attacker";
      raw[0] = JSON.stringify(ev);
      writeFileSync(path, raw.join("\n") + "\n", "utf-8");
      const after = await reader.verifyChain();
      expect(after.valid).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues the chain across a fresh writer on the same file", () => {
    const dir = join(import.meta.dirname ?? ".", ".tmp-chain2");
    const path = join(dir, "audit.jsonl");
    mkdirSync(dir, { recursive: true });
    try {
      const first = new AuditLog(path);
      first.emit(buildEvent("s1", 1, "Read", { file_path: "docs/a.md" }, GOVERNED, undefined, "approved", 5));
      first.emit(buildEvent("s1", 2, "Read", { file_path: "docs/b.md" }, GOVERNED, undefined, "approved", 5));

      // A brand-new writer (process restart) must pick up the prior head.
      const second = new AuditLog(path);
      second.emit(buildEvent("s1", 3, "Read", { file_path: "docs/c.md" }, GOVERNED, undefined, "approved", 5));

      const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
      expect(verifyAuditChain(lines).valid).toBe(true);
      expect(verifyAuditChain(lines).entries).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// -- (b) signed decision trace ------------------------------------------------

function makeTrace(): DecisionTrace {
  return {
    task: "answer the audit question",
    taskTerms: [],
    asOf: "2026-07-30",
    capabilities: {} as never,
    plan: {} as never,
    units: [
      { id: "u1", path: "docs/a.md", outcome: "selected", gates: [{ gate: "relevance", passed: true }] },
      { id: "u2", path: "docs/b.md", outcome: "skipped", rejectedBy: "recency", gates: [{ gate: "recency", passed: false }] },
    ],
    gateSummary: [{ gate: "relevance", passed: 1, failed: 0 }],
  } as unknown as DecisionTrace;
}

describe("signed decision trace", () => {
  it("signs a trace event that verifies with the public key", async () => {
    const { privatePem, publicPem } = newKeypair();
    const event = toTraceEvent(makeTrace(), { sessionId: "s1", ts: "2026-07-30T00:00:00.000Z" });
    const signed = await signTraceEvent(privatePem, event, "trace-key-1");

    expect(signed.signature?.algorithm).toBe("ed25519");
    expect(signed.signature?.keyId).toBe("trace-key-1");
    expect(await verifyTraceEvent(signed)).toBe(true);
    expect(await verifyTraceEvent(signed, [publicPem])).toBe(true);
  });

  it("DETECTS a tampered trace field", async () => {
    const { privatePem } = newKeypair();
    const event = toTraceEvent(makeTrace(), { sessionId: "s1", ts: "2026-07-30T00:00:00.000Z" });
    const signed = await signTraceEvent(privatePem, event);
    // Rewrite the verdict count after signing.
    signed.selected = 99;
    expect(await verifyTraceEvent(signed)).toBe(false);
  });

  it("rejects a trace with no signature", async () => {
    const event = toTraceEvent(makeTrace(), { sessionId: "s1" });
    expect(await verifyTraceEvent(event)).toBe(false);
  });
});

// -- (c) signed export bundle -------------------------------------------------

describe("signed export bundle", () => {
  const TEST_DIR = join(import.meta.dirname ?? ".", ".tmp-export-sig");
  const LOG_PATH = join(TEST_DIR, "audit.jsonl");
  const OUT_DIR = join(TEST_DIR, "evidence");

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Build a real hash-chained log with the writer so the head hash is genuine.
    const log = new AuditLog(LOG_PATH);
    log.emit(buildLifecycleEvent("s1", 1, "session_start"));
    log.emit(buildEvent("s1", 2, "Read", { file_path: "docs/a.md" }, GOVERNED, undefined, "approved", 5));
    log.emit(buildEvent("s1", 3, "Write", { file_path: "docs/b.md" }, GOVERNED, undefined, "blocked", 5));
  });
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("writes a signature that verifies over the manifest bytes", async () => {
    const { privatePem, publicPem } = newKeypair();
    const result = await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "soc2",
      signingKey: { privatePem, keyId: "export-key-1" },
    });

    expect(result.signed).toBe(true);
    expect(result.files).toContain("signature.json");

    const manifestBytes = readFileSync(join(OUT_DIR, "manifest.json"), "utf-8");
    const sig = JSON.parse(readFileSync(join(OUT_DIR, "signature.json"), "utf-8"));
    expect(sig.algorithm).toBe("ed25519");
    expect(sig.keyId).toBe("export-key-1");
    expect(await verifyDetached(manifestBytes, sig, [publicPem])).toBe(true);

    // The signed manifest commits to the audit chain head — anchoring the log.
    const manifest = JSON.parse(manifestBytes);
    expect(manifest.auditChain.entries).toBe(3);
    expect(manifest.auditChain.head).toHaveLength(64);
    expect(manifest.auditChain.head).not.toBe(GENESIS_HASH);
  });

  it("DETECTS a manifest edited after signing", async () => {
    const { privatePem, publicPem } = newKeypair();
    await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "soc2",
      signingKey: { privatePem },
    });
    const sig = JSON.parse(readFileSync(join(OUT_DIR, "signature.json"), "utf-8"));
    const tampered = readFileSync(join(OUT_DIR, "manifest.json"), "utf-8").replace(
      /"events":\s*3/,
      '"events": 999',
    );
    expect(await verifyDetached(tampered, sig, [publicPem])).toBe(false);
  });

  it("leaves the bundle unsigned when no key is supplied (backward-compatible)", async () => {
    const result = await exportEvidence({ auditPath: LOG_PATH, outputDir: OUT_DIR, format: "soc2" });
    expect(result.signed).toBeFalsy();
    expect(existsSync(join(OUT_DIR, "signature.json"))).toBe(false);
  });
});

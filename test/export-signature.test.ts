// Signed export bundle — a compliance evidence export can be sealed with a
// detached ed25519 signature over a canonical index of every file it contains
// (path + sha256). An auditor recomputes the index and verifies it with the
// public key; altering any exported file breaks the seal. On main the bundle is
// unsigned — this is the gap.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { exportEvidence } from "../src/export.js";
import { verifyEvidence, type EvidenceSignature } from "../src/resolution-signature.js";
import { canonicalJSON, sha256Hex } from "../src/canonical.js";
import type { AuditEvent } from "../src/audit.js";

const TEST_DIR = join(import.meta.dirname ?? ".", ".tmp-export-sig");
const LOG_PATH = join(TEST_DIR, "audit.jsonl");
const OUT_DIR = join(TEST_DIR, "evidence");

function newKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

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
  writeFileSync(LOG_PATH, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

interface SealFile {
  path: string;
  sha256: string;
}
interface Seal {
  bundle: { files: SealFile[]; [k: string]: unknown };
  signature: EvidenceSignature;
}

describe("exportEvidence — signed bundle", () => {
  it("leaves the bundle unsigned when no signing key is given", async () => {
    writeLog([makeEvent({ type: "session_start" })]);
    const result = await exportEvidence({ auditPath: LOG_PATH, outputDir: OUT_DIR, format: "soc2" });
    expect(result.files).not.toContain("signature.json");
    expect(existsSync(join(OUT_DIR, "signature.json"))).toBe(false);
  });

  it("seals the bundle and verifies with the public key", async () => {
    const { privatePem, publicPem } = newKeypair();
    writeLog([
      makeEvent({ type: "session_start" }),
      makeEvent({ type: "tool_call", sequence: 2, classification: { governed: true, reason: "x" } }),
    ]);

    const result = await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "soc2",
      signingKey: privatePem,
      keyId: "export-key-1",
    });

    expect(result.files).toContain("signature.json");
    const seal = JSON.parse(readFileSync(join(OUT_DIR, "signature.json"), "utf-8")) as Seal;
    expect(seal.signature.algorithm).toBe("ed25519");
    expect(seal.signature.keyId).toBe("export-key-1");

    // The seal verifies against the recomputed canonical bundle index.
    expect(await verifyEvidence(canonicalJSON(seal.bundle), seal.signature, [publicPem])).toBe(true);

    // Every listed file's recorded hash matches its bytes on disk.
    for (const f of seal.bundle.files) {
      expect(sha256Hex(readFileSync(join(OUT_DIR, f.path), "utf-8"))).toBe(f.sha256);
    }
  });

  it("DETECTS post-hoc tampering of an exported evidence file", async () => {
    const { privatePem, publicPem } = newKeypair();
    writeLog([makeEvent({ type: "session_start" })]);

    await exportEvidence({
      auditPath: LOG_PATH,
      outputDir: OUT_DIR,
      format: "soc2",
      signingKey: privatePem,
    });

    const seal = JSON.parse(readFileSync(join(OUT_DIR, "signature.json"), "utf-8")) as Seal;
    // The signature itself still verifies (we did not touch the seal)...
    expect(await verifyEvidence(canonicalJSON(seal.bundle), seal.signature, [publicPem])).toBe(true);

    // ...but a forged evidence file no longer matches its recorded hash.
    const victim = seal.bundle.files.find((f) => f.path.endsWith(".json") && f.path !== "manifest.json");
    expect(victim).toBeDefined();
    const target = join(OUT_DIR, victim!.path);
    const forged = JSON.parse(readFileSync(target, "utf-8")) as Record<string, unknown>;
    forged["evidenceCount"] = 9999;
    writeFileSync(target, JSON.stringify(forged, null, 2) + "\n", "utf-8");

    expect(sha256Hex(readFileSync(target, "utf-8"))).not.toBe(victim!.sha256);
  });
});

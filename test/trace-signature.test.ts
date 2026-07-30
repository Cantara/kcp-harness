// Signed decision trace — the emitted, content-free decision trace carries a
// detached ed25519 signature over its canonical bytes, reusing the same key
// mechanism as signed resolutions/receipts. An auditor verifies the trace with
// the public key; any tampered field breaks the signature. On main the trace
// is unsigned — this is the gap.

import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  toTraceEvent,
  canonicalTraceEvent,
  signTraceEvent,
  verifyTraceEvent,
  type TraceEvent,
} from "../src/trace-emit.js";
import type { DecisionTrace } from "kcp-agent";

function newKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const TRACE: DecisionTrace = {
  task: "access docs/policy.md",
  asOf: "2026-07-22",
  units: [
    {
      id: "policy",
      path: "docs/policy.md",
      outcome: "selected",
      score: 0.9,
      gates: [{ gate: "relevance", passed: true, detail: "match" }],
    },
  ],
  gateSummary: [{ gate: "relevance", passed: 1, failed: 0 }],
} as unknown as DecisionTrace;

function baseEvent(): TraceEvent {
  return toTraceEvent(TRACE, { sessionId: "sess-1", ts: "2026-07-22T10:00:00.000Z" });
}

describe("canonicalTraceEvent — deterministic serialization", () => {
  it("is independent of the signature field and key order", () => {
    const e = baseEvent();
    const withSig = { ...e, signature: { algorithm: "ed25519", value: "x", publicKey: "y" } } as TraceEvent;
    expect(canonicalTraceEvent(withSig)).toBe(canonicalTraceEvent(e));
  });
});

describe("signTraceEvent / verifyTraceEvent", () => {
  it("signs the trace and verifies with the public key", async () => {
    const { privatePem, publicPem } = newKeypair();
    const signed = await signTraceEvent(privatePem, baseEvent(), "trace-key-1");

    expect(signed.signature?.algorithm).toBe("ed25519");
    expect(signed.signature?.keyId).toBe("trace-key-1");
    expect(await verifyTraceEvent(signed)).toBe(true);
    expect(await verifyTraceEvent(signed, [publicPem])).toBe(true);
  });

  it("fails verification against a different pinned key", async () => {
    const { privatePem } = newKeypair();
    const other = newKeypair();
    const signed = await signTraceEvent(privatePem, baseEvent());
    expect(await verifyTraceEvent(signed, [other.publicPem])).toBe(false);
  });

  it("DETECTS a tampered trace field", async () => {
    const { privatePem } = newKeypair();
    const signed = await signTraceEvent(privatePem, baseEvent());

    const forged: TraceEvent = { ...signed, selected: signed.selected + 1 };
    expect(await verifyTraceEvent(forged)).toBe(false);
  });

  it("fails closed on an unsigned trace", async () => {
    expect(await verifyTraceEvent(baseEvent())).toBe(false);
  });
});

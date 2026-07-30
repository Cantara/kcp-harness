// Canonical serialization + hashing for tamper-evident evidence.
//
// One deterministic JSON encoding shared by the audit hash-chain (audit.ts) and
// the Ed25519 evidence signatures over the decision trace (trace-emit.ts) and
// the export bundle (export.ts). Object keys are emitted in sorted order at
// every depth, so a value serializes byte-for-byte identically regardless of
// the order its fields were constructed in — the property every hash and
// signature over structured evidence depends on. `undefined` members are
// dropped, matching JSON.stringify (they never survive a JSON round-trip), so a
// value re-read from disk canonicalizes to the same bytes it was written with.

import { createHash } from "node:crypto";

/** Deterministic, key-sorted JSON serialization of a value. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** Recursively rebuild a value with object keys in sorted order. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

/** Lowercase hex sha256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

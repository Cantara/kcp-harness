// Signed approval resolutions — non-repudiable reviewer identity.
//
// An ApprovalResolution names a reviewer and a policyRef, but nothing in the
// state machine proves the operator who typed the resolution IS that reviewer.
// A signed resolution closes that gap: the reviewer signs a canonical payload
// of the decision with an ed25519 private key, and the harness verifies the
// signature before accepting the resolution. Under
// `approvals.require_signed_resolutions`, an unsigned or invalid resolution is
// not a valid resolution — the provider fails closed.
//
// The ed25519 primitives here mirror kcp-agent's `src/verify.ts`
// (`decodeBytes` + `webcrypto.subtle.importKey(..., { name: "Ed25519" })`),
// which only VERIFIES; this module adds the signing side (subtle.sign) for the
// CLI and tests, plus a PEM convenience that derives the public key.

import { webcrypto, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

/** The fields a resolution signature commits to. */
export interface ResolutionSignaturePayload {
  /** Ticket id. */
  id: string;
  /** Classified target of the governed call. */
  target: string;
  /** Tool name of the governed call. */
  tool: string;
  /** Terminal state chosen by the reviewer. */
  state: "approved" | "dismissed";
  /** Named reviewer. */
  reviewer: string;
  /** Policy/regulatory citation satisfied. */
  policyRef: string;
  /** Resolution timestamp (reviewedAt). */
  timestamp: string;
}

/** Detached ed25519 signature over a resolution's canonical payload. */
export interface ResolutionSignature {
  /** Signature scheme — always ed25519. */
  algorithm: "ed25519";
  /** base64 detached signature bytes over the canonical payload. */
  value: string;
  /** Reviewer public key (PEM SPKI, base64/hex DER, or raw 32-byte). */
  publicKey: string;
  /** Optional key identifier, recorded for audit. */
  keyId?: string;
}

/**
 * Deterministic serialization of the resolution fields the signature commits
 * to. Field order is fixed and versioned so a signature made today verifies
 * byte-for-byte tomorrow, independent of object construction order.
 */
export function canonicalResolutionPayload(p: ResolutionSignaturePayload): string {
  return JSON.stringify({
    v: 1,
    id: p.id,
    target: p.target,
    tool: p.tool,
    state: p.state,
    reviewer: p.reviewer,
    policyRef: p.policyRef,
    timestamp: p.timestamp,
  });
}

const B64 = /^[A-Za-z0-9+/=\s]+$/;
const HEX = /^[0-9a-fA-F\s]+$/;

/** Decode PEM / base64 / hex key or signature material to bytes (mirrors kcp-agent verify.ts). */
function decodeBytes(material: string): Uint8Array | undefined {
  const s = material.trim();
  const pem = s.match(/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/);
  if (pem) return Uint8Array.from(Buffer.from(pem[1].replace(/\s+/g, ""), "base64"));
  if (HEX.test(s) && s.replace(/\s+/g, "").length % 2 === 0 && s.replace(/\s+/g, "").length >= 64) {
    return Uint8Array.from(Buffer.from(s.replace(/\s+/g, ""), "hex"));
  }
  if (B64.test(s)) return Uint8Array.from(Buffer.from(s.replace(/\s+/g, ""), "base64"));
  return undefined;
}

/** Is this value inline key material rather than a file path? */
function looksInlineKey(value: string): boolean {
  if (value.includes("-----BEGIN")) return true;
  const bytes = decodeBytes(value);
  // Raw ed25519 material: 32 (raw key) or 44 (SPKI DER) bytes.
  return !!bytes && [32, 44].includes(bytes.length);
}

/** Resolve a trusted-key entry (inline material or a file path) to key material. */
function loadKeyMaterial(entry: string): string {
  return looksInlineKey(entry) ? entry : readFileSync(entry, "utf8");
}

/** Import an ed25519 public key for verification (mirrors kcp-agent verify.ts). */
export async function importPublicKey(material: string): Promise<webcrypto.CryptoKey> {
  const bytes = decodeBytes(material);
  if (!bytes) throw new Error("unrecognized public key encoding");
  const format = bytes.length === 32 ? "raw" : "spki";
  return await webcrypto.subtle.importKey(format, bytes, { name: "Ed25519" }, false, ["verify"]);
}

/** Import an ed25519 private key (PKCS8) for signing. */
export async function importPrivateKey(material: string): Promise<webcrypto.CryptoKey> {
  const bytes = decodeBytes(material);
  if (!bytes) throw new Error("unrecognized private key encoding");
  return await webcrypto.subtle.importKey("pkcs8", bytes, { name: "Ed25519" }, false, ["sign"]);
}

/** Sign a canonical payload with an ed25519 private key; returns base64 signature. */
export async function signPayload(privateKey: webcrypto.CryptoKey, payload: string): Promise<string> {
  const sig = await webcrypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(payload));
  return Buffer.from(sig).toString("base64");
}

/**
 * Build a resolution signature from a PKCS8 PEM private key (the CLI path):
 * derives the matching SPKI public key, signs the canonical payload, and
 * returns the detached-signature envelope to attach to the resolution.
 */
export async function signResolution(
  privatePem: string,
  payload: ResolutionSignaturePayload,
  keyId?: string,
): Promise<ResolutionSignature> {
  const priv = createPrivateKey(privatePem);
  const publicKeyPem = createPublicKey(priv).export({ type: "spki", format: "pem" }).toString();
  const pkcs8Der = priv.export({ type: "pkcs8", format: "der" });
  const key = await webcrypto.subtle.importKey(
    "pkcs8",
    pkcs8Der,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const value = await signPayload(key, canonicalResolutionPayload(payload));
  return { algorithm: "ed25519", value, publicKey: publicKeyPem, ...(keyId ? { keyId } : {}) };
}

/**
 * Verify a resolution signature over its canonical payload. Fail-closed:
 * returns false for any missing/malformed input rather than throwing.
 *
 * When `trustedKeys` is non-empty the signature must verify against one of the
 * pinned reviewer keys — this is what binds the signature to an identity. When
 * no keys are pinned, the envelope's embedded public key is used, which proves
 * integrity of the payload but is self-attesting for identity.
 */
export async function verifyResolutionSignature(
  payload: ResolutionSignaturePayload,
  signature: ResolutionSignature | undefined,
  trustedKeys?: string[],
): Promise<boolean> {
  if (!signature || signature.algorithm !== "ed25519") return false;
  const sigBytes = decodeBytes(signature.value);
  if (!sigBytes || sigBytes.length !== 64) return false;
  const message = new TextEncoder().encode(canonicalResolutionPayload(payload));

  const candidates =
    trustedKeys && trustedKeys.length > 0
      ? trustedKeys.map(loadKeyMaterialSafe).filter((k): k is string => k !== undefined)
      : [signature.publicKey];

  for (const material of candidates) {
    try {
      const key = await importPublicKey(material);
      if (await webcrypto.subtle.verify("Ed25519", key, sigBytes, message)) return true;
    } catch {
      // A key we cannot import or that does not verify never grants trust.
    }
  }
  return false;
}

/** loadKeyMaterial that never throws — an unreadable trusted key simply drops out. */
function loadKeyMaterialSafe(entry: string): string | undefined {
  try {
    return loadKeyMaterial(entry);
  } catch {
    return undefined;
  }
}

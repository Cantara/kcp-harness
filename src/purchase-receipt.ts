// Signed purchase receipts — non-repudiable proof a governed buy settled (#139).
//
// When a PURCHASE action clears the conformance gate and settles, the harness
// records what was bought. A signed receipt closes the same gap a signed
// resolution does: the settling authority signs a canonical payload of the
// purchase with an ed25519 private key, and any auditor verifies the signature
// before trusting the receipt. A tampered amount, vendor, or wallet breaks the
// signature — the receipt fails closed rather than lying about what was spent.
//
// The ed25519 primitives here mirror `src/resolution-signature.ts` (and, under
// it, kcp-agent's `src/verify.ts`): the same `decodeBytes` +
// `webcrypto.subtle` importKey/sign/verify, the same fail-closed discipline.

import { webcrypto, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

/** The fields a purchase-receipt signature commits to. */
export interface PurchaseReceiptPayload {
  /** Receipt id — the settlement record's identifier. */
  id: string;
  /** The vendor paid. */
  vendor: string;
  /** The amount spent, in `currency`. */
  amount: number;
  /** The currency of the amount. */
  currency: string;
  /** The wallet/account the funds moved from. */
  wallet: string;
  /** Settlement timestamp (ISO 8601). */
  timestamp: string;
}

/** Detached ed25519 signature over a purchase receipt's canonical payload. */
export interface PurchaseReceiptSignature {
  /** Signature scheme — always ed25519. */
  algorithm: "ed25519";
  /** base64 detached signature bytes over the canonical payload. */
  value: string;
  /** Settling-authority public key (PEM SPKI, base64/hex DER, or raw 32-byte). */
  publicKey: string;
  /** Optional key identifier, recorded for audit. */
  keyId?: string;
}

/**
 * Deterministic serialization of the receipt fields the signature commits to.
 * Field order is fixed and versioned so a signature made today verifies
 * byte-for-byte tomorrow, independent of object construction order.
 */
export function canonicalPurchaseReceiptPayload(p: PurchaseReceiptPayload): string {
  return JSON.stringify({
    v: 1,
    id: p.id,
    vendor: p.vendor,
    amount: p.amount,
    currency: p.currency,
    wallet: p.wallet,
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

/** loadKeyMaterial that never throws — an unreadable trusted key simply drops out. */
function loadKeyMaterialSafe(entry: string): string | undefined {
  try {
    return loadKeyMaterial(entry);
  } catch {
    return undefined;
  }
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
 * Build a purchase-receipt signature from a PKCS8 PEM private key: derives the
 * matching SPKI public key, signs the canonical payload, and returns the
 * detached-signature envelope to attach to the receipt.
 */
export async function signPurchaseReceipt(
  privatePem: string,
  payload: PurchaseReceiptPayload,
  keyId?: string,
): Promise<PurchaseReceiptSignature> {
  const priv = createPrivateKey(privatePem);
  const publicKeyPem = createPublicKey(priv).export({ type: "spki", format: "pem" }).toString();
  const pkcs8Der = priv.export({ type: "pkcs8", format: "der" });
  const key = await webcrypto.subtle.importKey("pkcs8", pkcs8Der, { name: "Ed25519" }, false, ["sign"]);
  const value = await signPayload(key, canonicalPurchaseReceiptPayload(payload));
  return { algorithm: "ed25519", value, publicKey: publicKeyPem, ...(keyId ? { keyId } : {}) };
}

/**
 * Verify a purchase-receipt signature over its canonical payload. Fail-closed:
 * returns false for any missing/malformed input rather than throwing.
 *
 * When `trustedKeys` is non-empty the signature must verify against one of the
 * pinned settling-authority keys — this is what binds the receipt to an
 * identity. When no keys are pinned, the envelope's embedded public key is used,
 * which proves integrity of the payload but is self-attesting for identity.
 */
export async function verifyPurchaseReceipt(
  payload: PurchaseReceiptPayload,
  signature: PurchaseReceiptSignature | undefined,
  trustedKeys?: string[],
): Promise<boolean> {
  if (!signature || signature.algorithm !== "ed25519") return false;
  const sigBytes = decodeBytes(signature.value);
  if (!sigBytes || sigBytes.length !== 64) return false;
  const message = new TextEncoder().encode(canonicalPurchaseReceiptPayload(payload));

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

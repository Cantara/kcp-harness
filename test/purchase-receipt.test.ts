// Signed purchase receipts — non-repudiable proof a governed buy settled (#139).
//
// Mirrors the resolution-signature tests: canonical payload determinism, the
// PEM sign path, verify roundtrip, tamper rejection across every committed
// field, trusted-key identity pinning, and fail-closed on malformed input. The
// signed receipt is the audit-grade record that binds a settled purchase —
// vendor, amount, currency, wallet — to a key, so a later reader can prove what
// was spent without trusting the log's integrity alone.

import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  canonicalPurchaseReceiptPayload,
  signPurchaseReceipt,
  verifyPurchaseReceipt,
  type PurchaseReceiptPayload,
  type PurchaseReceiptSignature,
} from "../src/purchase-receipt.js";
import { buildPurchaseEvent } from "../src/audit.js";
import { InMemoryAuditLog } from "../src/audit.js";

function newKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const RECEIPT: PurchaseReceiptPayload = {
  id: "rcpt-001",
  vendor: "acme-supplies",
  amount: 250,
  currency: "USD",
  wallet: "wallet-treasury-1",
  timestamp: "2026-07-22T10:00:00.000Z",
};

describe("canonicalPurchaseReceiptPayload — deterministic serialization", () => {
  it("emits a fixed, versioned field order regardless of construction order", () => {
    const reordered: PurchaseReceiptPayload = {
      timestamp: RECEIPT.timestamp,
      wallet: RECEIPT.wallet,
      currency: RECEIPT.currency,
      amount: RECEIPT.amount,
      vendor: RECEIPT.vendor,
      id: RECEIPT.id,
    };
    expect(canonicalPurchaseReceiptPayload(reordered)).toBe(canonicalPurchaseReceiptPayload(RECEIPT));
    expect(canonicalPurchaseReceiptPayload(RECEIPT)).toBe(
      JSON.stringify({
        v: 1,
        id: "rcpt-001",
        vendor: "acme-supplies",
        amount: 250,
        currency: "USD",
        wallet: "wallet-treasury-1",
        timestamp: "2026-07-22T10:00:00.000Z",
      }),
    );
  });
});

describe("signPurchaseReceipt / verifyPurchaseReceipt — roundtrip + tamper", () => {
  it("signs with a PEM key and verifies against the embedded public key", async () => {
    const { privatePem } = newKeypair();
    const sig = await signPurchaseReceipt(privatePem, RECEIPT, "treasury-key-1");
    expect(sig.algorithm).toBe("ed25519");
    expect(sig.keyId).toBe("treasury-key-1");
    expect(await verifyPurchaseReceipt(RECEIPT, sig)).toBe(true);
  });

  it("verifies against a pinned trusted key (identity binding)", async () => {
    const { privatePem, publicPem } = newKeypair();
    const sig = await signPurchaseReceipt(privatePem, RECEIPT);
    expect(await verifyPurchaseReceipt(RECEIPT, sig, [publicPem])).toBe(true);
  });

  it("rejects a receipt when a pinned trusted key is not the signer", async () => {
    const signer = newKeypair();
    const other = newKeypair();
    const sig = await signPurchaseReceipt(signer.privatePem, RECEIPT);
    expect(await verifyPurchaseReceipt(RECEIPT, sig, [other.publicPem])).toBe(false);
  });

  it.each([
    ["amount", { ...RECEIPT, amount: 999999 }],
    ["vendor", { ...RECEIPT, vendor: "shady-llc" }],
    ["currency", { ...RECEIPT, currency: "EUR" }],
    ["wallet", { ...RECEIPT, wallet: "wallet-attacker" }],
    ["id", { ...RECEIPT, id: "rcpt-forged" }],
    ["timestamp", { ...RECEIPT, timestamp: "2020-01-01T00:00:00.000Z" }],
  ])("rejects a receipt whose %s was tampered after signing", async (_field, tampered) => {
    const { privatePem } = newKeypair();
    const sig = await signPurchaseReceipt(privatePem, RECEIPT);
    // Signature was made over the ORIGINAL — verifying the tampered payload fails.
    expect(await verifyPurchaseReceipt(tampered as PurchaseReceiptPayload, sig)).toBe(false);
  });

  it("fails closed on missing or malformed signature material", async () => {
    expect(await verifyPurchaseReceipt(RECEIPT, undefined)).toBe(false);
    expect(
      await verifyPurchaseReceipt(RECEIPT, { algorithm: "ed25519", value: "not-base64!!", publicKey: "x" } as PurchaseReceiptSignature),
    ).toBe(false);
    expect(
      await verifyPurchaseReceipt(RECEIPT, { algorithm: "rsa", value: "AAAA", publicKey: "x" } as unknown as PurchaseReceiptSignature),
    ).toBe(false);
  });
});

describe("buildPurchaseEvent — settled purchase audit record (#139)", () => {
  it("records the transacted buy and its signed receipt, correlation-stamped", async () => {
    const audit = new InMemoryAuditLog();
    const { privatePem } = newKeypair();
    const sig = await signPurchaseReceipt(privatePem, RECEIPT, "treasury-key-1");

    audit.emit(buildPurchaseEvent("session-1", 7, RECEIPT, sig, "corr-abc"));

    const ev = audit.events.find((e) => e.type === "purchase_settled");
    expect(ev).toBeDefined();
    expect(ev!.outcome).toBe("approved");
    expect(ev!.correlationId).toBe("corr-abc");
    expect(ev!.purchase!.vendor).toBe("acme-supplies");
    expect(ev!.purchase!.amount).toBe(250);
    expect(ev!.purchase!.currency).toBe("USD");
    expect(ev!.purchase!.receipt).toBe("rcpt-001");
    expect(ev!.purchase!.signed).toBe(true);
    expect(ev!.purchase!.keyId).toBe("treasury-key-1");
    expect(ev!.purchase!.signature).toBe(sig.value);
  });

  it("records an unsigned settlement without a signature block", () => {
    const audit = new InMemoryAuditLog();
    audit.emit(buildPurchaseEvent("session-1", 8, RECEIPT));
    const ev = audit.events.find((e) => e.type === "purchase_settled")!;
    expect(ev.purchase!.signed).toBeUndefined();
    expect(ev.purchase!.signature).toBeUndefined();
  });
});

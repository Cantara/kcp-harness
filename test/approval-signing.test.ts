// Signed approval resolutions — non-repudiable reviewer identity (issue #35).
//
// Covers the canonical payload + sign/verify helpers, provider-level
// fail-closed enforcement under require_signed_resolutions, trusted-key
// identity pinning, CLI signing, file persistence, and config parsing.

import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryApprovalProvider,
  FileApprovalProvider,
  newRequest,
  type ApprovalRequest,
  type ApprovalResolution,
} from "../src/approval.js";
import {
  canonicalResolutionPayload,
  signResolution,
  signPayload,
  importPrivateKey,
  verifyResolutionSignature,
  type ResolutionSignature,
} from "../src/resolution-signature.js";
import { parseConfig } from "../src/config.js";
import { runApprovals } from "../src/approvals-cli.js";
import { InMemoryAuditLog } from "../src/audit.js";

function newKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function makeRequest(): ApprovalRequest {
  return newRequest({
    sessionId: "session-1",
    toolName: "Write",
    target: "customers/acme/contract.md",
    task: "amend contract",
    requiredRole: "account-owner",
    evidence: { policyRef: "POL-7.2", detail: "named human sign-off required" },
  });
}

async function signedResolutionFor(
  req: ApprovalRequest,
  privatePem: string,
  overrides: Partial<Pick<ApprovalResolution, "state" | "reviewer" | "policyRef">> = {},
  keyId?: string,
): Promise<ApprovalResolution> {
  const state = overrides.state ?? "approved";
  const reviewer = overrides.reviewer ?? "Kari N.";
  const policyRef = overrides.policyRef ?? "POL-7.2";
  const reviewedAt = new Date().toISOString();
  const signature = await signResolution(
    privatePem,
    { id: req.id, target: req.target, tool: req.toolName, state, reviewer, policyRef, timestamp: reviewedAt },
    keyId,
  );
  return { id: req.id, state, reviewer, reviewedAt, policyRef, signature };
}

// -- Canonical payload + helpers ---------------------------------------------

describe("canonical resolution payload", () => {
  it("is deterministic and field-ordered regardless of input key order", () => {
    const a = canonicalResolutionPayload({
      id: "t1", target: "x", tool: "Write", state: "approved",
      reviewer: "Kari N.", policyRef: "POL-7.2", timestamp: "2026-07-22T10:00:00.000Z",
    });
    // Same fields, different object literal order → identical bytes.
    const b = canonicalResolutionPayload({
      timestamp: "2026-07-22T10:00:00.000Z", policyRef: "POL-7.2", reviewer: "Kari N.",
      state: "approved", tool: "Write", target: "x", id: "t1",
    });
    expect(a).toBe(b);
    expect(a).toContain('"v":1');
    expect(a).toContain('"reviewer":"Kari N."');
  });

  it("sign helper roundtrips against verify helper", async () => {
    const { privatePem, publicPem } = newKeypair();
    const payload = {
      id: "t1", target: "x", tool: "Write", state: "approved" as const,
      reviewer: "Kari N.", policyRef: "POL-7.2", timestamp: "2026-07-22T10:00:00.000Z",
    };
    const sig = await signResolution(privatePem, payload, "kari-2026");
    expect(sig.algorithm).toBe("ed25519");
    expect(sig.keyId).toBe("kari-2026");
    expect(await verifyResolutionSignature(payload, sig)).toBe(true);
    // Pinned to the reviewer's own key: still verifies.
    expect(await verifyResolutionSignature(payload, sig, [publicPem])).toBe(true);
  });

  it("verify fails when any signed field is altered", async () => {
    const { privatePem } = newKeypair();
    const payload = {
      id: "t1", target: "x", tool: "Write", state: "approved" as const,
      reviewer: "Kari N.", policyRef: "POL-7.2", timestamp: "2026-07-22T10:00:00.000Z",
    };
    const sig = await signResolution(privatePem, payload);
    expect(await verifyResolutionSignature({ ...payload, reviewer: "Mallory" }, sig)).toBe(false);
    expect(await verifyResolutionSignature({ ...payload, state: "dismissed" }, sig)).toBe(false);
  });

  it("signPayload works from a raw imported PKCS8 private key", async () => {
    const { privatePem, publicPem } = newKeypair();
    const key = await importPrivateKey(privatePem);
    const payload = {
      id: "t1", target: "x", tool: "Write", state: "approved" as const,
      reviewer: "Kari N.", policyRef: "POL-7.2", timestamp: "2026-07-22T10:00:00.000Z",
    };
    const value = await signPayload(key, canonicalResolutionPayload(payload));
    const sig: ResolutionSignature = { algorithm: "ed25519", value, publicKey: publicPem };
    expect(await verifyResolutionSignature(payload, sig)).toBe(true);
  });
});

// -- Provider fail-closed enforcement ----------------------------------------

describe("require_signed_resolutions enforcement", () => {
  it("accepts a valid signature when required", async () => {
    const { privatePem } = newKeypair();
    const provider = new InMemoryApprovalProvider({ requireSigned: true });
    const req = makeRequest();
    await provider.submit(req);
    const res = await signedResolutionFor(req, privatePem);
    const status = await provider.resolve(res);
    expect(status.state).toBe("approved");
    expect(status.resolution?.signature).toBeDefined();
  });

  it("rejects a missing signature when required (fail-closed)", async () => {
    const provider = new InMemoryApprovalProvider({ requireSigned: true });
    const req = makeRequest();
    await provider.submit(req);
    const res: ApprovalResolution = {
      id: req.id, state: "approved", reviewer: "Kari N.",
      reviewedAt: new Date().toISOString(), policyRef: "POL-7.2",
    };
    await expect(provider.resolve(res)).rejects.toThrow(/requires a signature/i);
    // The ticket stays pending — an unsigned resolution is not a resolution.
    expect((await provider.check(req.id))?.state).toBe("pending_review");
  });

  it("rejects an invalid signature when required (tampered field)", async () => {
    const { privatePem } = newKeypair();
    const provider = new InMemoryApprovalProvider({ requireSigned: true });
    const req = makeRequest();
    await provider.submit(req);
    const res = await signedResolutionFor(req, privatePem);
    // Change the reviewer after signing → payload no longer matches signature.
    const tampered: ApprovalResolution = { ...res, reviewer: "Mallory" };
    await expect(provider.resolve(tampered)).rejects.toThrow(/invalid signature/i);
    expect((await provider.check(req.id))?.state).toBe("pending_review");
  });

  it("accepts an unsigned resolution when not required (behavior unchanged)", async () => {
    const provider = new InMemoryApprovalProvider(); // no policy → not required
    const req = makeRequest();
    await provider.submit(req);
    const res: ApprovalResolution = {
      id: req.id, state: "approved", reviewer: "Kari N.",
      reviewedAt: new Date().toISOString(), policyRef: "POL-7.2",
    };
    const status = await provider.resolve(res);
    expect(status.state).toBe("approved");
  });

  it("stores a signature even when not required", async () => {
    const { privatePem } = newKeypair();
    const provider = new InMemoryApprovalProvider(); // not required
    const req = makeRequest();
    await provider.submit(req);
    const res = await signedResolutionFor(req, privatePem);
    const status = await provider.resolve(res);
    expect(status.resolution?.signature?.algorithm).toBe("ed25519");
  });
});

// -- Trusted-key identity pinning --------------------------------------------

describe("trusted-key pinning", () => {
  it("rejects a signature from an untrusted key even if the envelope is self-consistent", async () => {
    const reviewer = newKeypair();
    const attacker = newKeypair();
    const provider = new InMemoryApprovalProvider({
      requireSigned: true,
      trustedKeys: [reviewer.publicPem],
    });
    const req = makeRequest();
    await provider.submit(req);
    // Attacker signs with their own key; envelope carries the attacker key.
    const res = await signedResolutionFor(req, attacker.privatePem);
    await expect(provider.resolve(res)).rejects.toThrow(/invalid signature/i);
  });

  it("accepts a signature from a trusted reviewer key", async () => {
    const reviewer = newKeypair();
    const provider = new InMemoryApprovalProvider({
      requireSigned: true,
      trustedKeys: [reviewer.publicPem],
    });
    const req = makeRequest();
    await provider.submit(req);
    const res = await signedResolutionFor(req, reviewer.privatePem);
    const status = await provider.resolve(res);
    expect(status.state).toBe("approved");
  });
});

// -- File provider persistence -----------------------------------------------

describe("file provider persists signatures", () => {
  it("replays the signature from the JSONL log on a fresh read", async () => {
    const { privatePem } = newKeypair();
    const dir = mkdtempSync(join(tmpdir(), "kcp-sign-"));
    const writer = new FileApprovalProvider(dir, { requireSigned: true });
    const req = makeRequest();
    await writer.submit(req);
    await writer.resolve(await signedResolutionFor(req, privatePem, {}, "kari-2026"));

    // A separate process/instance reads the same log.
    const reader = new FileApprovalProvider(dir);
    const status = await reader.check(req.id);
    expect(status?.state).toBe("approved");
    expect(status?.resolution?.signature?.keyId).toBe("kari-2026");
  });
});

// -- CLI signing --------------------------------------------------------------

describe("approvals CLI signs resolutions", () => {
  it("--private-key attaches a verifiable signature and audit records it", async () => {
    const { privatePem } = newKeypair();
    const dir = mkdtempSync(join(tmpdir(), "kcp-cli-"));
    const keyPath = join(dir, "reviewer.pem");
    writeFileSync(keyPath, privatePem, "utf-8");

    const config = parseConfig(`
version: "1.0"
governance:
  domains: []
  policy:
    fail_closed: true
  approvals:
    provider: file
    dir: ${JSON.stringify(dir)}
    require_signed_resolutions: true
    rules:
      - required_role: account-owner
downstream: []
audit:
  path: ${JSON.stringify(join(dir, "audit.jsonl"))}
`);

    // Open a ticket directly on the same store the CLI will read.
    const store = new FileApprovalProvider(dir);
    const req = makeRequest();
    await store.submit(req);

    const audit = new InMemoryAuditLog();
    const out = await runApprovals(
      ["approve", req.id, "--reviewer", "Kari N.", "--policy-ref", "POL-7.2",
        "--private-key", keyPath, "--key-id", "kari-2026"],
      config,
      audit,
    );
    expect(out).toMatch(/approved/);
    expect(out).toMatch(/\[signed kari-2026\]/);

    const status = await new FileApprovalProvider(dir).check(req.id);
    expect(status?.resolution?.signature).toBeDefined();
    expect(await verifyResolutionSignature(
      {
        id: req.id, target: req.target, tool: req.toolName, state: "approved",
        reviewer: status!.resolution!.reviewer, policyRef: status!.resolution!.policyRef,
        timestamp: status!.resolution!.reviewedAt,
      },
      status!.resolution!.signature,
    )).toBe(true);

    const event = audit.events.find((e) => e.type === "approval_resolved");
    expect(event?.approval?.signed).toBe(true);
    expect(event?.approval?.keyId).toBe("kari-2026");
  });

  it("without --private-key, fail-closed store rejects the unsigned resolution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kcp-cli-unsigned-"));
    const config = parseConfig(`
version: "1.0"
governance:
  domains: []
  policy:
    fail_closed: true
  approvals:
    provider: file
    dir: ${JSON.stringify(dir)}
    require_signed_resolutions: true
    rules:
      - required_role: account-owner
downstream: []
audit:
  path: ${JSON.stringify(join(dir, "audit.jsonl"))}
`);
    const store = new FileApprovalProvider(dir);
    const req = makeRequest();
    await store.submit(req);

    await expect(
      runApprovals(["approve", req.id, "--reviewer", "Kari N.", "--policy-ref", "POL-7.2"], config),
    ).rejects.toThrow(/requires a signature/i);
  });
});

// -- Config parsing -----------------------------------------------------------

describe("approvals signature config parsing", () => {
  it("parses require_signed_resolutions and trusted_keys", () => {
    const config = parseConfig(`
version: "1.0"
governance:
  domains: []
  policy:
    fail_closed: true
  approvals:
    provider: file
    require_signed_resolutions: true
    trusted_keys:
      - "./keys/kari.pem"
      - "./keys/erik.pem"
    rules:
      - required_role: account-owner
downstream: []
audit:
  path: .kcp-harness/audit.jsonl
`);
    expect(config.governance.approvals?.require_signed_resolutions).toBe(true);
    expect(config.governance.approvals?.trusted_keys).toEqual(["./keys/kari.pem", "./keys/erik.pem"]);
  });

  it("defaults require_signed_resolutions to false and trusted_keys to undefined", () => {
    const config = parseConfig(`
version: "1.0"
governance:
  domains: []
  policy:
    fail_closed: true
  approvals:
    provider: file
    rules:
      - required_role: account-owner
downstream: []
audit:
  path: .kcp-harness/audit.jsonl
`);
    expect(config.governance.approvals?.require_signed_resolutions).toBe(false);
    expect(config.governance.approvals?.trusted_keys).toBeUndefined();
  });
});

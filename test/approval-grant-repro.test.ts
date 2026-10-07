// Reproduction of the standing-grant flaw: one reviewer click used to be a permanent grant for a
// (tool, target) pair across every session, forever. These tests use only the pre-fix API.

import { describe, it, expect } from "vitest";
import { govern, type ApprovalContext } from "../src/governor.js";
import type { Classification } from "../src/classifier.js";
import { createSession } from "../src/session.js";
import type { GovernancePolicy, ApprovalRule } from "../src/config.js";
import { InMemoryApprovalProvider, newRequest } from "../src/approval.js";

const policy: GovernancePolicy = { fail_closed: true, audit_all: true, max_units: 5, strict: false };
const RULE: ApprovalRule = {
  match: { tools: ["Write"], paths: ["records/"] },
  required_role: "account-owner",
  policy_ref: "POL-7.2",
};
const TARGET = "records/customer-7.md";

function cls(): Classification {
  return {
    governed: true,
    reason: "governed",
    domain: { manifest: "./no-such-knowledge.yaml", paths: ["records/"] },
    target: TARGET,
  } as Classification;
}

async function approvedTicket(provider: InMemoryApprovalProvider, sessionId: string, reviewedAt: string) {
  const req = newRequest({
    sessionId, toolName: "Write", target: TARGET, task: "t", requiredRole: "account-owner", evidence: {},
  });
  await provider.submit(req);
  await provider.resolve({ id: req.id, state: "approved", reviewer: "Kari N.", reviewedAt, policyRef: "POL-7.2" });
  return req;
}

describe("reproduction: an approval must not be a standing grant", () => {
  it("approval granted to session A must NOT approve a call from session B", async () => {
    const provider = new InMemoryApprovalProvider();
    const ctx: ApprovalContext = { provider, rules: [RULE] };
    await approvedTicket(provider, "session-A", new Date().toISOString());

    const sessionB = createSession();
    const decision = await govern(cls(), "Write", {}, sessionB, policy, ctx);
    expect(decision.approved).toBe(false);
  });

  it("an approval from three days ago must NOT approve a call today", async () => {
    const provider = new InMemoryApprovalProvider();
    const ctx: ApprovalContext = { provider, rules: [RULE] };
    const session = createSession();
    await approvedTicket(provider, session.id, new Date(Date.now() - 3 * 24 * 3600_000).toISOString());

    const decision = await govern(cls(), "Write", {}, session, policy, ctx);
    expect(decision.approved).toBe(false);
  });

  it("a dismissed ticket newer than an approved one must block (older approval must not leak through)", async () => {
    const provider = new InMemoryApprovalProvider();
    const ctx: ApprovalContext = { provider, rules: [RULE] };
    const session = createSession();
    await approvedTicket(provider, session.id, new Date().toISOString());
    const second = newRequest({
      sessionId: session.id, toolName: "Write", target: TARGET, task: "t", requiredRole: "account-owner", evidence: {},
    });
    await provider.submit(second);
    await provider.resolve({ id: second.id, state: "dismissed", reviewer: "Kari N.", reviewedAt: new Date().toISOString(), policyRef: "POL-7.2" });

    const decision = await govern(cls(), "Write", {}, session, policy, ctx);
    expect(decision.approved).toBe(false);
  });
});

// An approval ticket is the one governance artifact that outlives the session: stored
// durably, resolved later by a named human, read back as evidence. It recorded `sessionId`
// and no correlation, so it pointed at a *session* — which holds many actions — rather than
// at the action a human actually signed off.
//
// "Which action did this person approve?" was answerable only by cross-referencing the audit
// event that happened to wrap the request. That holds while ticket and log sit together, and
// stops the moment a ticket is exported, migrated, or read on its own — which is exactly
// when an auditor is looking at it.

import { describe, it, expect } from "vitest";
import { govern, type ApprovalContext } from "../src/governor.js";
import type { Classification } from "../src/classifier.js";
import { createSession } from "../src/session.js";
import type { GovernancePolicy } from "../src/config.js";
import {
  InMemoryApprovalProvider,
  type ApprovalProvider,
  type ApprovalRule,
} from "../src/approval.js";
import { deriveCorrelation } from "../src/correlation.js";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const STORED = deriveCorrelation({ traceparent: TRACEPARENT }).correlationId;

const policy: GovernancePolicy = { fail_closed: true, audit_all: true, max_units: 5, strict: false };

const RULE: ApprovalRule = {
  match: { tools: ["Write"], paths: ["records/"] },
  required_role: "account-owner",
  policy_ref: "POL-7.2",
};

const classified = (target: string): Classification => ({
  governed: true,
  reason: `path ${target} is governed`,
  domain: { manifest: "./no-such-knowledge.yaml", paths: ["records/"] },
  target,
});

async function openTicket(args: Record<string, unknown>): Promise<ApprovalProvider> {
  const provider = new InMemoryApprovalProvider();
  const approvals: ApprovalContext = { provider, rules: [RULE] };
  await govern(classified("records/x.md"), "Write", args, createSession(), policy, approvals);
  return provider;
}

describe("the ticket names the action a human is being asked about", () => {
  it("carries the correlation derived from the intercepted call", async () => {
    const provider = await openTicket({ file_path: "records/x.md", traceparent: TRACEPARENT });
    const [status] = await provider.list({ state: "pending_review" });
    expect(status, "no ticket was opened").toBeDefined();
    expect(status.request.correlationId, "the ticket cannot name the action it is about").toBe(STORED);
  });

  // MCP carries request metadata under _meta; the audit path already honours both, and a
  // ticket that only understood one would be correlated or not depending on the transport.
  it("honours a traceparent under _meta as the audit path does", async () => {
    const provider = await openTicket({ file_path: "records/x.md", _meta: { traceparent: TRACEPARENT } });
    const [status] = await provider.list({ state: "pending_review" });
    expect(status.request.correlationId).toBe(STORED);
  });

  // An uncorrelated call must not gain an invented id: a ticket claiming to belong to a
  // chain that does not exist is worse than one that admits it stands alone.
  it("leaves the field absent when the call carried no traceparent", async () => {
    const provider = await openTicket({ file_path: "records/x.md" });
    const [status] = await provider.list({ state: "pending_review" });
    expect(status.request.correlationId).toBeUndefined();
  });
});

// The human's resolution is the record an audit cares most about: a named person approved
// this action, citing this policy. It was the one link in the chain that did not join.
//
// `runApprovals` emitted the approval_resolved event without a correlation id, so the moment
// a reviewer resolved a ticket, the resulting evidence dropped out of the decision chain for
// the very action it authorised. The ticket now carries the id (see the ApprovalRequest
// change), so the CLI has it available and simply was not passing it on.

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApprovals } from "../src/approvals-cli.js";
import { FileApprovalProvider, newRequest } from "../src/approval.js";
import { AuditLog, InMemoryAuditLog, buildApprovalEvent } from "../src/audit.js";
import { AuditReader } from "../src/audit-reader.js";
import { parseConfig } from "../src/config.js";
import { deriveCorrelation } from "../src/correlation.js";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const STORED = deriveCorrelation({ traceparent: TRACEPARENT }).correlationId;

function configFor(dir: string) {
  return parseConfig(`
version: "1.0"
governance:
  domains: []
  policy:
    fail_closed: true
  approvals:
    provider: file
    dir: ${JSON.stringify(dir)}
    rules:
      - required_role: account-owner
downstream: []
audit:
  path: ${JSON.stringify(join(dir, "audit.jsonl"))}
`);
}

async function resolveTicket(correlationId?: string) {
  const dir = mkdtempSync(join(tmpdir(), "kcp-res-"));
  const store = new FileApprovalProvider(dir);
  const req = newRequest({
    sessionId: "session-1",
    toolName: "Write",
    target: "customers/acme/contract.md",
    task: "amend contract",
    requiredRole: "account-owner",
    evidence: { policyRef: "POL-7.2" },
    ...(correlationId ? { correlationId } : {}),
  });
  await store.submit(req);

  const audit = new InMemoryAuditLog();
  await runApprovals(
    ["approve", req.id, "--reviewer", "Kari N.", "--policy-ref", "POL-7.2"],
    configFor(dir),
    audit,
  );
  return audit.events.find((e) => e.type === "approval_resolved");
}

describe("the human's resolution joins the chain it authorised", () => {
  it("carries the ticket's correlation id", async () => {
    const event = await resolveTicket(STORED);
    expect(event, "no approval_resolved event was emitted").toBeDefined();
    expect(
      event?.correlationId,
      "a named human's approval must be traceable to the action it authorised",
    ).toBe(STORED);
  });

  // A pre-#34 ticket, or one opened by a call that carried no traceparent, has nothing to
  // pass on. The event must not gain an invented id — that would assert a link that was
  // never established.
  it("stays uncorrelated when the ticket was", async () => {
    const event = await resolveTicket();
    expect(event).toBeDefined();
    expect(event?.correlationId).toBeUndefined();
  });
});

// The point of all of it: an auditor holding the traceparent for a task can retrieve the
// whole cascade — the request a gate raised, and the named human's resolution — as one
// chain, using the id form the runtime actually has rather than the one this proxy stores.
describe("the chain retrieves end to end by the id a runtime holds", () => {
  it("request and resolution come back together", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kcp-chain-"));
    const store = new FileApprovalProvider(dir);
    const req = newRequest({
      sessionId: "session-1",
      toolName: "Write",
      target: "customers/acme/contract.md",
      task: "amend contract",
      requiredRole: "account-owner",
      evidence: { policyRef: "POL-7.2" },
      correlationId: STORED,
    });
    await store.submit(req);

    const auditPath = join(dir, "audit.jsonl");
    const audit = new AuditLog(auditPath);
    audit.emit(buildApprovalEvent("session-1", 1, "approval_requested", { state: "pending_review", request: req }, STORED));
    await runApprovals(
      ["approve", req.id, "--reviewer", "Kari N.", "--policy-ref", "POL-7.2"],
      configFor(dir),
      audit,
    );

    // The runtime holds the traceparent; this proxy stored the trace-id.
    const chain = await new AuditReader(auditPath).decisionChain(TRACEPARENT);
    expect(chain, "the traceparent must resolve to the stored chain").toBeDefined();
    expect(chain!.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["approval_requested", "approval_resolved"]),
    );
  });
});

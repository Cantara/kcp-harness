// Confidence-gate wiring — kcp-agent decides, kcp-harness enforces.
//
// harness_assess runs kcp-agent's post-synthesis assess() over an answer.
// A passing verdict is allowed through; a failing verdict on a routed
// config opens an ApprovalRequest carrying the ConfidenceVerdict as
// evidence — "below threshold on critical → route to a human" is exactly
// a pending approval. A named human's approval overrides the gate on retry.

import { describe, it, expect } from "vitest";
import { HarnessProxy } from "../src/proxy.js";
import { parseConfig, type HarnessConfig } from "../src/config.js";
import { InMemoryAuditLog } from "../src/audit.js";

function confidenceConfig(extra = ""): HarnessConfig {
  return parseConfig(`
version: "1.0"
governance:
  domains:
    - manifest: ./no-such-knowledge.yaml
      paths: [records/]
  policy:
    fail_closed: true
    audit_all: true
  approvals:
    provider: memory
    rules: []
  confidence:
    threshold: 0.7
    severity: critical
    route_to_role: account-owner
    expires_after: 72h
    policy_ref: POL-9.1
${extra}
downstream: []
audit:
  path: .kcp-harness/audit.jsonl
`);
}

async function callAssess(proxy: HarnessProxy, args: Record<string, unknown>) {
  const response = (await proxy.handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "harness_assess", arguments: args },
  })) as { result: { content: Array<{ text: string }>; isError: boolean } };
  return {
    isError: response.result.isError,
    body: JSON.parse(response.result.content[0].text) as Record<string, any>,
  };
}

const TASK = "draft customer risk assessment";

describe("harness_assess", () => {
  it("is listed as a tool", async () => {
    const proxy = new HarnessProxy({ config: confidenceConfig(), audit: new InMemoryAuditLog() });
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0", id: 1, method: "tools/list",
    })) as { result: { tools: Array<{ name: string }> } };
    expect(response.result.tools.map((t) => t.name)).toContain("harness_assess");
  });

  it("passing verdict → allowed, with the verdict attached", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = new HarnessProxy({ config: confidenceConfig(), audit });
    const { body } = await callAssess(proxy, { task: TASK, answer: "Low risk. Confidence: 0.9" });

    expect(body.allowed).toBe(true);
    expect(body.verdict.gate).toBe("confidence");
    expect(body.verdict.passed).toBe(true);
    expect(body.verdict.threshold).toBe(0.7);
    expect(body.verdict.severity).toBe("critical");

    const events = audit.events.filter((e) => e.type === "confidence_verdict");
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("approved");
    expect(events[0].confidence?.passed).toBe(true);
    expect(events[0].confidence?.score).toBe(0.9);
  });

  it("failing verdict → not allowed, ticket opened with the verdict as evidence", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = new HarnessProxy({ config: confidenceConfig(), audit });
    const { body } = await callAssess(proxy, { task: TASK, answer: "Unsure. Confidence: 0.4" });

    expect(body.allowed).toBe(false);
    expect(body.verdict.passed).toBe(false);
    expect(body.ticket?.state).toBe("pending_review");
    expect(body.ticket?.requiredRole).toBe("account-owner");

    const provider = proxy.getApprovalProvider()!;
    const [ticket] = await provider.list();
    expect(ticket.request.toolName).toBe("harness_assess");
    expect(ticket.request.target).toBe(TASK);
    expect(ticket.request.evidence.policyRef).toBe("POL-9.1");
    expect(ticket.request.evidence.confidence?.passed).toBe(false);
    expect(ticket.request.evidence.confidence?.score).toBe(0.4);

    expect(audit.events.some((e) => e.type === "approval_requested")).toBe(true);
    const verdictEvent = audit.events.find((e) => e.type === "confidence_verdict");
    expect(verdictEvent?.outcome).toBe("blocked");
  });

  it("no self-report → fail-closed → routed to a human", async () => {
    const proxy = new HarnessProxy({ config: confidenceConfig(), audit: new InMemoryAuditLog() });
    const { body } = await callAssess(proxy, { task: TASK, answer: "A conclusion with no confidence report." });
    expect(body.allowed).toBe(false);
    expect(body.verdict.detail).toMatch(/no confidence signal/i);
    expect(body.ticket?.state).toBe("pending_review");
  });

  it("retry while pending reuses the ticket", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = new HarnessProxy({ config: confidenceConfig(), audit });
    const first = await callAssess(proxy, { task: TASK, answer: "Unsure. Confidence: 0.4" });
    const second = await callAssess(proxy, { task: TASK, answer: "Unsure. Confidence: 0.4" });
    expect(second.body.ticket?.id).toBe(first.body.ticket?.id);
    expect(audit.events.filter((e) => e.type === "approval_requested")).toHaveLength(1);
  });

  it("human approval overrides the gate on retry", async () => {
    const proxy = new HarnessProxy({ config: confidenceConfig(), audit: new InMemoryAuditLog() });
    await callAssess(proxy, { task: TASK, answer: "Unsure. Confidence: 0.4" });

    const provider = proxy.getApprovalProvider()!;
    const [ticket] = await provider.list({ state: "pending_review" });
    await provider.resolve({
      id: ticket.request.id,
      state: "approved",
      reviewer: "Kari N.",
      reviewedAt: new Date().toISOString(),
      policyRef: "POL-9.1",
    });

    const { body } = await callAssess(proxy, { task: TASK, answer: "Unsure. Confidence: 0.4" });
    expect(body.allowed).toBe(true);
    expect(body.verdict.passed).toBe(false); // the gate still failed — the human overrode it
    expect(body.override?.reviewer).toBe("Kari N.");
    expect(body.override?.policyRef).toBe("POL-9.1");
  });

  it("dismissal is terminal — still not allowed, no new ticket", async () => {
    const proxy = new HarnessProxy({ config: confidenceConfig(), audit: new InMemoryAuditLog() });
    await callAssess(proxy, { task: TASK, answer: "Unsure. Confidence: 0.4" });

    const provider = proxy.getApprovalProvider()!;
    const [ticket] = await provider.list({ state: "pending_review" });
    await provider.resolve({
      id: ticket.request.id,
      state: "dismissed",
      reviewer: "Kari N.",
      reviewedAt: new Date().toISOString(),
      policyRef: "POL-9.1",
      note: "redo the analysis",
    });

    const { body } = await callAssess(proxy, { task: TASK, answer: "Unsure. Confidence: 0.4" });
    expect(body.allowed).toBe(false);
    expect(body.dismissed?.reviewer).toBe("Kari N.");
    expect(await provider.list()).toHaveLength(1);
  });

  it("the strictest threshold wins between config and caller", async () => {
    const proxy = new HarnessProxy({ config: confidenceConfig(), audit: new InMemoryAuditLog() });
    // config 0.7, caller 0.95, answer 0.8 → fails against 0.95
    const { body } = await callAssess(proxy, { task: TASK, answer: "OK. Confidence: 0.8", threshold: 0.95 });
    expect(body.verdict.threshold).toBe(0.95);
    expect(body.allowed).toBe(false);
  });

  it("works without approvals routing — verdict only, no ticket", async () => {
    const config = confidenceConfig();
    delete config.governance.approvals;
    config.governance.confidence!.route_to_role = undefined;
    const proxy = new HarnessProxy({ config, audit: new InMemoryAuditLog() });
    const { body } = await callAssess(proxy, { task: TASK, answer: "Unsure. Confidence: 0.4" });
    expect(body.allowed).toBe(false);
    expect(body.ticket).toBeUndefined();
  });

  it("caller threshold works with no confidence config at all", async () => {
    const config = confidenceConfig();
    delete config.governance.confidence;
    const proxy = new HarnessProxy({ config, audit: new InMemoryAuditLog() });
    const { body } = await callAssess(proxy, { task: TASK, answer: "OK. Confidence: 0.8", threshold: 0.5 });
    expect(body.allowed).toBe(true);
  });

  it("errors informatively when no threshold exists anywhere", async () => {
    const config = confidenceConfig();
    delete config.governance.confidence;
    const proxy = new HarnessProxy({ config, audit: new InMemoryAuditLog() });
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "harness_assess", arguments: { task: TASK, answer: "x" } },
    })) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toMatch(/threshold/i);
  });

  it("requires task and answer", async () => {
    const proxy = new HarnessProxy({ config: confidenceConfig(), audit: new InMemoryAuditLog() });
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "harness_assess", arguments: { task: TASK } },
    })) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toMatch(/answer/i);
  });
});

describe("confidence config parsing", () => {
  it("parses governance.confidence", () => {
    const config = confidenceConfig();
    expect(config.governance.confidence?.threshold).toBe(0.7);
    expect(config.governance.confidence?.severity).toBe("critical");
    expect(config.governance.confidence?.route_to_role).toBe("account-owner");
    expect(config.governance.confidence?.expires_after).toBe("72h");
    expect(config.governance.confidence?.policy_ref).toBe("POL-9.1");
  });

  it("rejects an out-of-range threshold", () => {
    expect(() => parseConfig(`
version: "1.0"
governance:
  domains: []
  policy: {}
  confidence:
    threshold: 7
downstream: []
audit: { path: a.jsonl }
`)).toThrow(/threshold/);
  });

  it("absent block parses as undefined", () => {
    const config = parseConfig(`
version: "1.0"
governance:
  domains: []
  policy: {}
downstream: []
audit: { path: a.jsonl }
`);
    expect(config.governance.confidence).toBeUndefined();
  });
});

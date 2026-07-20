// Proxy + audit + CLI surface for pending approvals.
//
// MCP has no async answer, so a pending decision surfaces as a structured
// deny carrying the ticket id, plus the harness_approvals tool for status.
// Every ticket opening and resolution is an audit event.

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessProxy } from "../src/proxy.js";
import { parseConfig, type HarnessConfig } from "../src/config.js";
import { InMemoryAuditLog, buildApprovalEvent } from "../src/audit.js";
import { FileApprovalProvider, newRequest } from "../src/approval.js";
import { runApprovals } from "../src/approvals-cli.js";

function approvalConfig(): HarnessConfig {
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
    rules:
      - match: { tools: [Write, Edit], paths: [records/] }
        required_role: account-owner
        expires_after: 72h
        policy_ref: POL-7.2
downstream: []
audit:
  path: .kcp-harness/audit.jsonl
`);
}

async function callTool(proxy: HarnessProxy, name: string, args: Record<string, unknown>) {
  const response = (await proxy.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result: { content: Array<{ text: string }>; isError: boolean } };
  return response.result;
}

describe("proxy with approval rules", () => {
  it("lists harness_approvals as a tool", async () => {
    const proxy = new HarnessProxy({ config: approvalConfig(), audit: new InMemoryAuditLog() });
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0", id: 1, method: "tools/list",
    })) as { result: { tools: Array<{ name: string }> } };
    expect(response.result.tools.map((t) => t.name)).toContain("harness_approvals");
  });

  it("rule-matched call → structured deny with ticket id + approval_requested audit event", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = new HarnessProxy({ config: approvalConfig(), audit });

    const result = await callTool(proxy, "Write", { file_path: "records/customer-7.md", content: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("BLOCKED");
    expect(result.content[0].text).toContain("pending approval");
    expect(result.content[0].text).toContain("account-owner");

    const requested = audit.events.filter((e) => e.type === "approval_requested");
    expect(requested).toHaveLength(1);
    expect(requested[0].approval?.state).toBe("pending_review");
    expect(requested[0].approval?.requiredRole).toBe("account-owner");
    expect(requested[0].approval?.policyRef).toBe("POL-7.2");

    const blocked = audit.events.find((e) => e.type === "tool_call");
    expect(blocked?.outcome).toBe("blocked");
    expect(blocked?.governance?.mode).toBe("pending");
  });

  it("retry while pending does not open a second ticket", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = new HarnessProxy({ config: approvalConfig(), audit });
    await callTool(proxy, "Write", { file_path: "records/customer-7.md", content: "x" });
    await callTool(proxy, "Write", { file_path: "records/customer-7.md", content: "x" });
    expect(audit.events.filter((e) => e.type === "approval_requested")).toHaveLength(1);
  });

  it("harness_approvals reports the pending ticket", async () => {
    const proxy = new HarnessProxy({ config: approvalConfig(), audit: new InMemoryAuditLog() });
    await callTool(proxy, "Write", { file_path: "records/customer-7.md", content: "x" });

    const result = await callTool(proxy, "harness_approvals", {});
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text) as { approvals: Array<Record<string, unknown>> };
    expect(parsed.approvals).toHaveLength(1);
    expect(parsed.approvals[0]["state"]).toBe("pending_review");
    expect(parsed.approvals[0]["requiredRole"]).toBe("account-owner");
  });

  it("after human approval, the retried call passes governance", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = new HarnessProxy({ config: approvalConfig(), audit });
    await callTool(proxy, "Write", { file_path: "records/customer-7.md", content: "x" });

    const provider = proxy.getApprovalProvider()!;
    const [ticket] = await provider.list({ state: "pending_review" });
    await provider.resolve({
      id: ticket.request.id,
      state: "approved",
      reviewer: "Kari N.",
      reviewedAt: new Date().toISOString(),
      policyRef: "POL-7.2",
    });

    const result = await callTool(proxy, "Write", { file_path: "records/customer-7.md", content: "x" });
    // Governance passed — the failure is now merely "no downstream owns Write",
    // not a governance block.
    expect(result.content[0].text).not.toContain("BLOCKED");
  });

  it("proxy without approvals config: harness_approvals says so", async () => {
    const config = approvalConfig();
    delete config.governance.approvals;
    const proxy = new HarnessProxy({ config, audit: new InMemoryAuditLog() });
    const result = await callTool(proxy, "harness_approvals", {});
    expect(result.content[0].text).toContain("no approval rules configured");
  });
});

describe("buildApprovalEvent", () => {
  it("captures ticket + resolution evidence", () => {
    const request = newRequest({
      sessionId: "s-1",
      toolName: "Write",
      target: "records/x.md",
      task: "Write records/x.md",
      requiredRole: "account-owner",
      evidence: { policyRef: "POL-7.2" },
    });
    const event = buildApprovalEvent("s-1", 3, "approval_resolved", {
      state: "approved",
      request,
      resolution: {
        id: request.id,
        state: "approved",
        reviewer: "Kari N.",
        reviewedAt: "2026-07-20T15:00:00Z",
        policyRef: "POL-7.2",
      },
    });
    expect(event.type).toBe("approval_resolved");
    expect(event.outcome).toBe("approved");
    expect(event.approval?.id).toBe(request.id);
    expect(event.approval?.reviewer).toBe("Kari N.");
    expect(event.approval?.policyRef).toBe("POL-7.2");
    expect(event.approval?.target).toBe("records/x.md");
  });
});

describe("approvals CLI", () => {
  function cliSetup() {
    const dir = mkdtempSync(join(tmpdir(), "kcp-approvals-cli-"));
    const config = approvalConfig();
    config.governance.approvals!.provider = "file";
    config.governance.approvals!.dir = dir;
    const audit = new InMemoryAuditLog();
    return { dir, config, audit };
  }

  async function seedTicket(dir: string): Promise<string> {
    const provider = new FileApprovalProvider(dir);
    const request = newRequest({
      sessionId: "s-1",
      toolName: "Write",
      target: "records/customer-7.md",
      task: "Write records/customer-7.md",
      requiredRole: "account-owner",
      evidence: { policyRef: "POL-7.2" },
    });
    await provider.submit(request);
    return request.id;
  }

  it("list shows tickets with state", async () => {
    const { dir, config, audit } = cliSetup();
    const id = await seedTicket(dir);
    const out = await runApprovals(["list"], config, audit);
    expect(out).toContain(id);
    expect(out).toContain("pending_review");
    expect(out).toContain("account-owner");
  });

  it("approve requires --reviewer and --policy-ref", async () => {
    const { dir, config, audit } = cliSetup();
    const id = await seedTicket(dir);
    await expect(runApprovals(["approve", id], config, audit)).rejects.toThrow(/--reviewer/);
    await expect(runApprovals(["approve", id, "--reviewer", "Kari N."], config, audit)).rejects.toThrow(/--policy-ref/);
  });

  it("approve resolves the ticket and emits approval_resolved", async () => {
    const { dir, config, audit } = cliSetup();
    const id = await seedTicket(dir);
    const out = await runApprovals(
      ["approve", id, "--reviewer", "Kari N.", "--policy-ref", "POL-7.2"],
      config, audit,
    );
    expect(out).toContain("approved");
    expect(out).toContain("Kari N.");

    const provider = new FileApprovalProvider(dir);
    expect((await provider.check(id))?.state).toBe("approved");

    const events = audit.events.filter((e) => e.type === "approval_resolved");
    expect(events).toHaveLength(1);
    expect(events[0].approval?.reviewer).toBe("Kari N.");
  });

  it("dismiss resolves the ticket with a note", async () => {
    const { dir, config, audit } = cliSetup();
    const id = await seedTicket(dir);
    await runApprovals(
      ["dismiss", id, "--reviewer", "Kari N.", "--policy-ref", "POL-7.2", "--note", "not warranted"],
      config, audit,
    );
    const provider = new FileApprovalProvider(dir);
    const status = await provider.check(id);
    expect(status?.state).toBe("dismissed");
    expect(status?.resolution?.note).toBe("not warranted");
  });

  it("errors without an approvals config", async () => {
    const { config, audit } = cliSetup();
    delete config.governance.approvals;
    await expect(runApprovals(["list"], config, audit)).rejects.toThrow(/approvals/i);
  });

  it("errors on unknown subcommand", async () => {
    const { config, audit } = cliSetup();
    await expect(runApprovals(["frobnicate"], config, audit)).rejects.toThrow(/unknown/i);
  });
});

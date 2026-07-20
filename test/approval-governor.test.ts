// Governor × approvals — human-approval rules evaluated before everything
// else the governor does. A matched rule means a named human decides, and
// no automated path (plan-first, auto-plan) may bypass that.

import { describe, it, expect } from "vitest";
import { govern, type ApprovalContext } from "../src/governor.js";
import type { Classification } from "../src/classifier.js";
import { createSession, addPlan } from "../src/session.js";
import type { GovernancePolicy } from "../src/config.js";
import { parseConfig } from "../src/config.js";
import {
  InMemoryApprovalProvider,
  type ApprovalProvider,
  type ApprovalRule,
} from "../src/approval.js";
import type { AgentPlan, PlannedUnit } from "kcp-agent";

const policy: GovernancePolicy = {
  fail_closed: true,
  audit_all: true,
  max_units: 5,
  strict: false,
};

const RULE: ApprovalRule = {
  match: { tools: ["Write", "Edit"], paths: ["records/"] },
  required_role: "account-owner",
  expires_after: "72h",
  policy_ref: "POL-7.2",
};

function ctx(rules: ApprovalRule[] = [RULE], provider: ApprovalProvider = new InMemoryApprovalProvider()): ApprovalContext {
  return { provider, rules };
}

function classified(toolName: string, target: string): Classification {
  return {
    governed: true,
    reason: `path ${target} is governed`,
    domain: { manifest: "./no-such-knowledge.yaml", paths: ["records/", "docs/"] },
    target,
  } as Classification;
}

function makePlan(units: Array<{ id: string; path: string }>): AgentPlan {
  return {
    task: "test task",
    manifest: { project: "test", version: "1.0" },
    trust: { requiresAttestation: false, agentCanAttest: false, note: "" },
    asOf: "2026-07-07",
    options: { capabilities: { role: "agent", paymentMethods: ["free"], credentials: [] }, maxUnits: 5, strict: false },
    selected: units.map((u) => ({
      id: u.id,
      path: u.path,
      intent: `intent for ${u.id}`,
      score: 10,
      reasons: ["test"],
      payment: { method: "free", settled: true, cost: 0 },
      requiresAttestation: false,
      loadEligible: true,
    })) as PlannedUnit[],
    skipped: [],
    federation: [],
    budget: { projectedSpend: 0, currency: "USDC" },
    context: { approximate: false, unmeasured: 0, note: "" },
    warnings: [],
  } as unknown as AgentPlan;
}

async function approveLatest(provider: ApprovalProvider, reviewer = "Kari N.") {
  const [status] = await provider.list({ state: "pending_review" });
  return provider.resolve({
    id: status.request.id,
    state: "approved",
    reviewer,
    reviewedAt: new Date().toISOString(),
    policyRef: "POL-7.2",
  });
}

describe("governor with approval rules", () => {
  it("matched rule with no ticket → pending, and a ticket is submitted", async () => {
    const approvals = ctx();
    const decision = await govern(
      classified("Write", "records/customer-7.md"),
      "Write", { file_path: "records/customer-7.md" },
      createSession(), policy, approvals,
    );

    expect(decision.approved).toBe(false);
    expect(decision.mode).toBe("pending");
    expect(decision.pendingId).toBeTruthy();
    expect(decision.submitted).toBe(true);
    expect(decision.reason).toContain("account-owner");
    expect(decision.reason).toContain(decision.pendingId!);

    const tickets = await approvals.provider.list();
    expect(tickets).toHaveLength(1);
    expect(tickets[0].state).toBe("pending_review");
    expect(tickets[0].request.requiredRole).toBe("account-owner");
    expect(tickets[0].request.evidence.policyRef).toBe("POL-7.2");
    expect(tickets[0].request.toolName).toBe("Write");
    // 72h TTL stamped on the ticket
    const ttl = Date.parse(tickets[0].request.expiresAt!) - Date.parse(tickets[0].request.requestedAt);
    expect(ttl).toBeCloseTo(72 * 3600_000, -4);
  });

  it("retry while pending → still pending, same ticket, no duplicate", async () => {
    const approvals = ctx();
    const session = createSession();
    const cls = classified("Write", "records/customer-7.md");
    const first = await govern(cls, "Write", {}, session, policy, approvals);
    const second = await govern(cls, "Write", {}, session, policy, approvals);

    expect(second.mode).toBe("pending");
    expect(second.submitted).toBeUndefined();
    expect(second.pendingId).toBe(first.pendingId);
    expect(await approvals.provider.list()).toHaveLength(1);
  });

  it("retry after human approval → approved with mode human-approved and the resolution attached", async () => {
    const approvals = ctx();
    const session = createSession();
    const cls = classified("Write", "records/customer-7.md");
    await govern(cls, "Write", {}, session, policy, approvals);
    await approveLatest(approvals.provider);

    const decision = await govern(cls, "Write", {}, session, policy, approvals);
    expect(decision.approved).toBe(true);
    expect(decision.mode).toBe("human-approved");
    expect(decision.resolution?.reviewer).toBe("Kari N.");
    expect(decision.resolution?.policyRef).toBe("POL-7.2");
    expect(decision.reason).toContain("Kari N.");
  });

  it("an approved plan does NOT bypass a human-approval rule", async () => {
    const approvals = ctx();
    const session = createSession();
    // Plan-first would approve this path...
    addPlan(session, "./knowledge.yaml", "update records", makePlan([{ id: "rec", path: "records/customer-7.md" }]));

    const decision = await govern(
      classified("Write", "records/customer-7.md"),
      "Write", {}, session, policy, approvals,
    );
    // ...but the rule outranks it: a named human must decide.
    expect(decision.approved).toBe(false);
    expect(decision.mode).toBe("pending");
  });

  it("dismissed is terminal — blocked, no re-submission", async () => {
    const approvals = ctx();
    const session = createSession();
    const cls = classified("Write", "records/customer-7.md");
    await govern(cls, "Write", {}, session, policy, approvals);
    const [status] = await approvals.provider.list();
    await approvals.provider.resolve({
      id: status.request.id,
      state: "dismissed",
      reviewer: "Kari N.",
      reviewedAt: new Date().toISOString(),
      policyRef: "POL-7.2",
      note: "not warranted",
    });

    const decision = await govern(cls, "Write", {}, session, policy, approvals);
    expect(decision.approved).toBe(false);
    expect(decision.mode).toBe("blocked");
    expect(decision.reason).toContain("Kari N.");
    expect(await approvals.provider.list()).toHaveLength(1);
  });

  it("expired ticket → fail-closed, and a fresh ticket is submitted", async () => {
    const approvals = ctx();
    const { newRequest } = await import("../src/approval.js");
    // Seed an already-expired ticket for this call
    await approvals.provider.submit(newRequest({
      sessionId: "s-old",
      toolName: "Write",
      target: "records/customer-7.md",
      task: "old",
      requiredRole: "account-owner",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      evidence: {},
    }));

    const decision = await govern(
      classified("Write", "records/customer-7.md"),
      "Write", {}, createSession(), policy, approvals,
    );
    expect(decision.approved).toBe(false);
    expect(decision.mode).toBe("pending");
    expect(decision.submitted).toBe(true);
    expect(await approvals.provider.list()).toHaveLength(2);
  });

  it("non-matching tool falls through to normal governance", async () => {
    const approvals = ctx();
    const decision = await govern(
      classified("Read", "records/customer-7.md"),
      "Read", {}, createSession(), policy, approvals,
    );
    // Rule matches Write|Edit only → normal path; manifest is unreachable → blocked, not pending
    expect(decision.mode).toBe("blocked");
    expect(await approvals.provider.list()).toHaveLength(0);
  });

  it("non-matching path falls through to normal governance", async () => {
    const approvals = ctx();
    const decision = await govern(
      classified("Write", "docs/readme.md"),
      "Write", {}, createSession(), policy, approvals,
    );
    expect(decision.mode).toBe("blocked");
    expect(await approvals.provider.list()).toHaveLength(0);
  });

  it("a rule with no path constraint matches on tool alone", async () => {
    const approvals = ctx([{ match: { tools: ["Write"] }, required_role: "ops" }]);
    const decision = await govern(
      classified("Write", "docs/readme.md"),
      "Write", {}, createSession(), policy, approvals,
    );
    expect(decision.mode).toBe("pending");
  });

  it("provider failure → blocked, fail-closed", async () => {
    const broken: ApprovalProvider = {
      submit: async () => { throw new Error("store offline"); },
      check: async () => { throw new Error("store offline"); },
      resolve: async () => { throw new Error("store offline"); },
      list: async () => { throw new Error("store offline"); },
    };
    const decision = await govern(
      classified("Write", "records/customer-7.md"),
      "Write", {}, createSession(), policy, ctx([RULE], broken),
    );
    expect(decision.approved).toBe(false);
    expect(decision.mode).toBe("blocked");
    expect(decision.reason).toContain("store offline");
  });

  it("no approvals context → existing behavior unchanged", async () => {
    const decision = await govern(
      classified("Write", "records/customer-7.md"),
      "Write", {}, createSession(), policy,
    );
    expect(decision.mode).toBe("blocked"); // manifest unreachable → auto-plan fails closed
  });
});

describe("approvals config parsing", () => {
  it("parses governance.approvals with rules", () => {
    const config = parseConfig(`
version: "1.0"
governance:
  domains:
    - manifest: ./knowledge.yaml
      paths: [records/]
  policy:
    fail_closed: true
  approvals:
    provider: file
    dir: .kcp-harness/approvals
    rules:
      - match: { tools: [Write, Edit], paths: [records/] }
        required_role: account-owner
        expires_after: 72h
        policy_ref: POL-7.2
downstream: []
audit:
  path: .kcp-harness/audit.jsonl
`);
    expect(config.governance.approvals?.provider).toBe("file");
    expect(config.governance.approvals?.dir).toBe(".kcp-harness/approvals");
    expect(config.governance.approvals?.rules).toHaveLength(1);
    const rule = config.governance.approvals!.rules[0];
    expect(rule.match.tools).toEqual(["Write", "Edit"]);
    expect(rule.match.paths).toEqual(["records/"]);
    expect(rule.required_role).toBe("account-owner");
    expect(rule.expires_after).toBe("72h");
    expect(rule.policy_ref).toBe("POL-7.2");
  });

  it("absent approvals block parses as undefined", () => {
    const config = parseConfig(`
version: "1.0"
governance:
  domains: []
  policy: {}
downstream: []
audit: { path: a.jsonl }
`);
    expect(config.governance.approvals).toBeUndefined();
  });

  it("rejects an approval rule without required_role", () => {
    expect(() => parseConfig(`
version: "1.0"
governance:
  domains: []
  policy: {}
  approvals:
    rules:
      - match: { tools: [Write] }
downstream: []
audit: { path: a.jsonl }
`)).toThrow(/required_role/);
  });
});

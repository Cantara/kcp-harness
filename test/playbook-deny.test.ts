/**
 * Playbook-level prohibitions and deny finality — KCP v0.32, §4.3b / RFC-0030.
 *
 * Two normative changes land here:
 *
 * 1. `action_scope.deny` on a `kind: playbook` unit is NORMATIVE for enactment — a
 *    blanket prohibition over every step. The effective denylist for a step is the
 *    UNION per dimension of the playbook's deny and the used skill's deny; a token
 *    matching EITHER source is denied, overriding any allow, deny-first,
 *    fail-closed. The matching source is the binding source, named in the decision
 *    and the audit (both, when both match).
 *
 * 2. A deny is NEVER grantable (amends RFC-0029's escalation sentence, for
 *    skill-level and playbook-level deny alike). A deny-hit raises a notify-only
 *    prohibited_attempt audit event — a distinct event type, not a pending
 *    approval ticket — and no approval resolution may enact the refused action.
 *    The only way past a deny is a new, reviewed, signed manifest version.
 *
 * The bypass is attempted explicitly below: a ticket crafted around the structural
 * guard and resolved "approved" by a named reviewer still does not enact the
 * denied action. If that test ever passes the action through, the audit log stops
 * meaning "this could not happen" and the compliance claim built on it is gone.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import {
  checkConformance,
  deniesToken,
  effectiveDeniesToken,
  type ActionScope,
} from "../src/conformance.js";
import { assessSkillEligibility } from "../src/governor.js";
import { createSession } from "../src/session.js";
import { HarnessProxy } from "../src/proxy.js";
import {
  InMemoryAuditLog,
  buildProhibitedAttemptEvent,
  verifyAuditChain,
  type AuditEvent,
} from "../src/audit.js";
import { newRequest, InMemoryApprovalProvider, FileApprovalProvider, type ApprovalRequest } from "../src/approval.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { GovernancePolicy, GovernedDomain, HarnessConfig } from "../src/config.js";

const MANIFEST = join(import.meta.dirname ?? ".", "fixtures", "playbook-deny", "knowledge.yaml");

const policy: GovernancePolicy = { fail_closed: true, audit_all: true, max_units: 10, strict: false };

// -- The union rule as a pure adjudication (mirrors the spec validator's
//    effectiveDeniesToken): a token matching EITHER source is denied. ----------

describe("effectiveDeniesToken — union of denies (RFC-0030 / KCP 0.32, §4.3b)", () => {
  const skillScope: ActionScope = { tools: ["Read"], deny: { paths: ["archive/frozen/**"] } };
  const playbookScope: ActionScope = { deny: { paths: ["legal/hold/**"], tools: ["transfer_ownership"] } };

  it("denies a token matched only by the skill's deny", () => {
    expect(effectiveDeniesToken([skillScope, playbookScope], "paths", "archive/frozen/2020.rec")).toBe(true);
  });

  it("denies a token matched only by the playbook's deny", () => {
    expect(effectiveDeniesToken([skillScope, playbookScope], "paths", "legal/hold/2025/x.rec")).toBe(true);
    expect(effectiveDeniesToken([skillScope, playbookScope], "tools", "transfer_ownership")).toBe(true);
  });

  it("passes a token neither source denies", () => {
    expect(effectiveDeniesToken([skillScope, playbookScope], "paths", "archive/expired/2020.rec")).toBe(false);
  });

  it("drops absent scopes from the union rather than failing on them", () => {
    expect(effectiveDeniesToken([undefined, playbookScope], "tools", "transfer_ownership")).toBe(true);
    expect(effectiveDeniesToken([undefined, undefined], "tools", "transfer_ownership")).toBe(false);
  });
});

// -- checkConformance with a playbook context: union, binding source, finality --

describe("checkConformance — playbook action_scope.deny (RFC-0030 / KCP 0.32)", () => {
  const skillScope: ActionScope = {
    tools: ["Read", "Bash", "transfer_ownership"],
    paths: ["archive/", "legal/"],
    deny: { paths: ["archive/frozen/**"] },
  };
  const playbook = {
    id: "gdpr-deletion-playbook",
    scope: { deny: { paths: ["legal/hold/**", "archive/frozen/**"], tools: ["transfer_ownership"] } } as ActionScope,
  };

  it("denies a token only the playbook prohibits — playbook is the binding source", () => {
    // The skill's allowlist grants legal/ — the playbook's blanket deny overrides it.
    const v = checkConformance({ tool: "Read", paths: ["legal/hold/2025/x.rec"] }, skillScope, playbook);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/deny/i);
    expect(v.reason).toMatch(/gdpr-deletion-playbook/);
    expect(v.prohibited).toBeDefined();
    expect(v.prohibited!.dimension).toBe("paths");
    expect(v.prohibited!.token).toBe("legal/hold/2025/x.rec");
    expect(v.prohibited!.bindingSources).toEqual(["playbook"]);
    expect(v.prohibited!.playbookId).toBe("gdpr-deletion-playbook");
  });

  it("denies a tool the skill allows but the playbook prohibits", () => {
    const v = checkConformance({ tool: "transfer_ownership" }, skillScope, playbook);
    expect(v.passed).toBe(false);
    expect(v.prohibited!.bindingSources).toEqual(["playbook"]);
    expect(v.prohibited!.dimension).toBe("tools");
  });

  it("denies a token only the skill prohibits — skill is the binding source", () => {
    const v = checkConformance({ tool: "Read", paths: ["archive/frozen/2019.rec"] }, { ...skillScope }, undefined);
    expect(v.passed).toBe(false);
    expect(v.prohibited).toBeDefined();
    expect(v.prohibited!.bindingSources).toEqual(["skill"]);
  });

  it("names BOTH binding sources when both denies match", () => {
    const v = checkConformance({ tool: "Read", paths: ["archive/frozen/2019.rec"] }, skillScope, playbook);
    expect(v.passed).toBe(false);
    expect(v.prohibited!.bindingSources).toEqual(["skill", "playbook"]);
    expect(v.reason).toMatch(/skill/i);
    expect(v.reason).toMatch(/gdpr-deletion-playbook/);
  });

  it("still passes an action neither source denies", () => {
    const v = checkConformance({ tool: "Read", paths: ["archive/expired/2020.rec"] }, skillScope, playbook);
    expect(v.passed).toBe(true);
    expect(v.prohibited).toBeUndefined();
  });

  it("adjudicates the playbook deny even when the skill declares no scope (inline-step bound)", () => {
    // An inline step's used scope is absent — scope-unbounded on the allow axis.
    // The playbook deny is the first hard edge it has: deny-first means the
    // prohibition decides BEFORE the no-scope fail-close, so the refusal is
    // final (prohibited) rather than a grantable hold.
    const v = checkConformance({ tool: "transfer_ownership" }, {}, playbook);
    expect(v.passed).toBe(false);
    expect(v.prohibited).toBeDefined();
    expect(v.prohibited!.bindingSources).toEqual(["playbook"]);
  });

  it("marks every deny-hit prohibited — skill-level denies are final too (RFC-0030 amends RFC-0029)", () => {
    const v = checkConformance({ tool: "Read", paths: ["archive/frozen/2019.rec"] }, skillScope);
    expect(v.prohibited).toBeDefined();
    expect(v.prohibited!.dimension).toBe("paths");
  });

  it("keeps deniesToken single-scope semantics unchanged (RFC-0029 rule intact)", () => {
    expect(deniesToken(playbook.scope, "paths", "legal/hold/x")).toBe(true);
    expect(deniesToken(playbook.scope, "paths", "archive/expired/x")).toBe(false);
  });
});

// -- prohibited_attempt is a first-class, hash-chained audit event -------------

describe("prohibited_attempt audit event (RFC-0030)", () => {
  it("builds a notify-only blocked event carrying token, dimension, and binding source", () => {
    const verdict = checkConformance(
      { tool: "Read", paths: ["legal/hold/2025/x.rec"] },
      { tools: ["Read"], paths: ["legal/"] },
      { id: "gdpr-deletion-playbook", scope: { deny: { paths: ["legal/hold/**"] } } },
    );
    const event = buildProhibitedAttemptEvent("session-1", 7, "cleanup-skill", verdict, "corr-1");
    expect(event.type).toBe("prohibited_attempt");
    expect(event.outcome).toBe("blocked");
    expect(event.prohibited!.skillId).toBe("cleanup-skill");
    expect(event.prohibited!.token).toBe("legal/hold/2025/x.rec");
    expect(event.prohibited!.dimension).toBe("paths");
    expect(event.prohibited!.bindingSources).toEqual(["playbook"]);
    expect(event.prohibited!.playbookId).toBe("gdpr-deletion-playbook");
    expect(event.prohibited!.reason).toMatch(/deny/i);
    expect(event.correlationId).toBe("corr-1");
  });

  it("joins the hash chain like every other event", () => {
    const audit = new InMemoryAuditLog();
    const verdict = checkConformance(
      { tool: "transfer_ownership" },
      { tools: ["Read"] , deny: { tools: ["transfer_ownership"] } },
    );
    audit.emit(buildProhibitedAttemptEvent("session-1", 1, "cleanup-skill", verdict));
    audit.emit(buildProhibitedAttemptEvent("session-1", 2, "cleanup-skill", verdict));
    expect(verifyAuditChain(audit.events).valid).toBe(true);
  });
});

// -- The structural guard: no grantable ticket can exist for a deny-hit --------

describe("a deny is never grantable — approval flow refuses the ticket (RFC-0030)", () => {
  const prohibitedVerdict = checkConformance(
    { tool: "Read", paths: ["legal/hold/2025/x.rec"] },
    { tools: ["Read"], paths: ["legal/"], deny: { paths: ["legal/hold/**"] } },
  );

  it("newRequest refuses to open a ticket carrying a prohibited verdict", () => {
    expect(() =>
      newRequest({
        sessionId: "s1",
        toolName: "Read",
        target: "legal/hold/2025/x.rec",
        task: "conformance: skill \"cleanup-skill\"",
        requiredRole: "reviewer",
        evidence: { conformance: prohibitedVerdict },
      }),
    ).toThrow(/never grantable/i);
  });

  it("the in-memory provider refuses to store such a ticket, whatever built it", async () => {
    const provider = new InMemoryApprovalProvider();
    const raw: ApprovalRequest = {
      id: "crafted-1",
      sessionId: "s1",
      toolName: "Read",
      target: "legal/hold/2025/x.rec",
      task: "crafted around newRequest",
      requiredRole: "reviewer",
      requestedAt: new Date().toISOString(),
      evidence: { conformance: prohibitedVerdict },
    };
    await expect(provider.submit(raw)).rejects.toThrow(/never grantable/i);
    expect(await provider.list()).toHaveLength(0);
  });

  it("the file provider refuses identically — the guard is channel-agnostic", async () => {
    const provider = new FileApprovalProvider(mkdtempSync(join(tmpdir(), "kcp-harness-deny-")));
    const raw: ApprovalRequest = {
      id: "crafted-2",
      sessionId: "s1",
      toolName: "Read",
      target: "legal/hold/2025/x.rec",
      task: "crafted around newRequest",
      requiredRole: "reviewer",
      requestedAt: new Date().toISOString(),
      evidence: { conformance: prohibitedVerdict },
    };
    await expect(provider.submit(raw)).rejects.toThrow(/never grantable/i);
    expect(await provider.list()).toHaveLength(0);
  });
});

// -- End to end through the proxy: the RFC-0030 acceptance scenarios -----------

const domain: GovernedDomain = {
  manifest: MANIFEST,
  paths: ["archive/", "legal/", "skills/", "playbooks/"],
  skills: ["Skill", "kcp_skill"],
  tools: ["transfer_ownership"],
};

const proxyConfig: HarnessConfig = {
  version: "1.0",
  governance: {
    domains: [domain],
    policy,
    approvals: { provider: "memory", rules: [] },
  },
  downstream: [],
  audit: { path: ":memory:" },
};

async function call(proxy: HarnessProxy, id: number, name: string, args: Record<string, unknown>) {
  const response = (await proxy.handleMessage({
    jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
  })) as { result: { content: Array<{ text: string }>; isError: boolean } };
  return response.result;
}

describe("HarnessProxy — playbook deny holds every step (RFC-0030 / KCP 0.32)", () => {
  let audit: InMemoryAuditLog;
  let proxy: HarnessProxy;

  beforeEach(async () => {
    audit = new InMemoryAuditLog();
    proxy = new HarnessProxy({ config: proxyConfig, audit });
    // Enact the playbook, then the skill its steps use — the playbook's blanket
    // deny must hold the step's actions even though the skill allows them.
    await call(proxy, 1, "Skill", { skill: "gdpr-deletion-playbook" });
    await call(proxy, 2, "Skill", { skill: "cleanup-skill" });
  });

  it("admits a kcp_version 0.32 manifest: both units load eligible", () => {
    expect(audit.events.filter((e) => e.type === "skill_loaded")).toHaveLength(2);
  });

  it("refuses a step action the playbook's deny prohibits — playbook named as binding source", async () => {
    const result = await call(proxy, 3, "Read", { file_path: "legal/hold/2025-brekstad/x.rec" });

    // (1) Refused, finally — fail-closed at the gate.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/CONFORMANCE BLOCKED/);
    expect(result.content[0].text).toMatch(/gdpr-deletion-playbook/);

    // (2) A prohibited_attempt event names the binding source — notify-only.
    const attempt = audit.events.find((e) => e.type === "prohibited_attempt");
    expect(attempt).toBeDefined();
    expect(attempt!.outcome).toBe("blocked");
    expect(attempt!.prohibited!.token).toBe("legal/hold/2025-brekstad/x.rec");
    expect(attempt!.prohibited!.dimension).toBe("paths");
    expect(attempt!.prohibited!.bindingSources).toEqual(["playbook"]);
    expect(attempt!.prohibited!.playbookId).toBe("gdpr-deletion-playbook");

    // (3) NOT a pending approval: no ticket exists, no approval_requested fired.
    expect(await proxy.getApprovalProvider()!.list()).toHaveLength(0);
    expect(audit.events.some((e) => e.type === "approval_requested")).toBe(false);

    // (4) The governance decision on the audited call surfaces the binding source.
    const held = audit.events.find((e) => e.type === "tool_call" && e.outcome === "blocked");
    expect(held).toBeDefined();
    expect(held!.governance?.prohibited?.bindingSources).toEqual(["playbook"]);

    // (5) The chain stays whole through the new event type.
    expect(verifyAuditChain(audit.events).valid).toBe(true);
  });

  it("refuses a tool the skill allows but the playbook prohibits", async () => {
    const result = await call(proxy, 3, "transfer_ownership", { file_path: "archive/expired/2020.rec" });
    expect(result.isError).toBe(true);
    const attempt = audit.events.find((e) => e.type === "prohibited_attempt");
    expect(attempt!.prohibited!.token).toBe("transfer_ownership");
    expect(attempt!.prohibited!.dimension).toBe("tools");
    expect(attempt!.prohibited!.bindingSources).toEqual(["playbook"]);
  });

  it("names both sources when the skill and the playbook both deny the token", async () => {
    await call(proxy, 3, "Read", { file_path: "archive/frozen/2019.rec" });
    const attempt = audit.events.find((e) => e.type === "prohibited_attempt");
    expect(attempt!.prohibited!.bindingSources).toEqual(["skill", "playbook"]);
  });

  it("still passes a step action neither deny prohibits", async () => {
    // No downstream owns Read in this rig, so the final result is a downstream
    // error either way — the governance record is the assertion surface, exactly
    // as in the conformance gate's own tests.
    const result = await call(proxy, 3, "Read", { file_path: "archive/expired/2020.rec" });
    expect(result.content[0].text).not.toMatch(/CONFORMANCE BLOCKED/);
    const verdict = audit.events.find((e) => e.type === "conformance_verdict");
    expect(verdict!.outcome).toBe("approved");
    expect(verdict!.conformance!.passed).toBe(true);
    expect(audit.events.some((e) => e.type === "prohibited_attempt")).toBe(false);
    expect(await proxy.getApprovalProvider()!.list()).toHaveLength(0);
  });

  it("a resolved approval never enacts a denied action — the bypass is attempted and refused", async () => {
    // First attempt: refused, prohibited_attempt raised, no ticket.
    await call(proxy, 3, "Read", { file_path: "legal/hold/2025/x.rec" });
    expect(await proxy.getApprovalProvider()!.list()).toHaveLength(0);

    // The bypass: craft a ticket for the same (target, tool) around the
    // structural guard — no conformance evidence attached — and have a named
    // reviewer approve it. For an ordinary out-of-scope hold this is exactly
    // the override that admits a retry; for a deny it must change nothing.
    const provider = proxy.getApprovalProvider()!;
    await provider.submit({
      id: "bypass-attempt-1",
      sessionId: "s1",
      toolName: "Read",
      target: "legal/hold/2025/x.rec",
      task: "acknowledged, but a deny is a boundary, not a threshold",
      requiredRole: "playbook-owner",
      requestedAt: new Date().toISOString(),
      evidence: { policyRef: "POL-LEGAL-HOLD" },
    });
    await provider.resolve({
      id: "bypass-attempt-1",
      state: "approved",
      reviewer: "playbook-owner@example.org",
      reviewedAt: new Date().toISOString(),
      policyRef: "POL-LEGAL-HOLD",
    });

    // Retry: whatever the owner clicked, the deletion does not happen.
    const retry = await call(proxy, 4, "Read", { file_path: "legal/hold/2025/x.rec" });
    expect(retry.isError).toBe(true);
    expect(retry.content[0].text).toMatch(/CONFORMANCE BLOCKED/);

    // A second prohibited_attempt is raised — repeated attempts to do forbidden
    // things is the governance signal the event exists to carry.
    expect(audit.events.filter((e) => e.type === "prohibited_attempt")).toHaveLength(2);

    // The refused operation is verifiably absent from the subsequent trace: no
    // approved conformance_verdict ever names the held target.
    const enacted = audit.events.filter(
      (e: AuditEvent) => e.type === "conformance_verdict" && e.outcome === "approved",
    );
    expect(enacted).toHaveLength(0);
  });
});

// -- kcp_version 0.32 manifests are admitted at the eligibility gate -----------

describe("kcp_version 0.32 manifests (RFC-0030)", () => {
  it("assesses eligibility from a 0.32 manifest without refusing the version", async () => {
    const v = await assessSkillEligibility(domain, "cleanup-skill", createSession(), policy);
    expect(v.eligible).toBe(true);
    expect(v.kind).toBe("skill");
  });

  it("recovers the playbook's deny-only action_scope from the raw manifest", async () => {
    const v = await assessSkillEligibility(domain, "gdpr-deletion-playbook", createSession(), policy);
    expect(v.eligible).toBe(true);
    expect(v.kind).toBe("playbook");
    // kcp-agent's parser drops `deny` — the governor must recover it, or the
    // playbook's one normative sub-object (§4.3b) silently fails OPEN.
    expect(v.actionScope?.deny?.paths).toContain("legal/hold/**");
    expect(v.actionScope?.deny?.tools).toContain("transfer_ownership");
  });
});

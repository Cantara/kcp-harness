// Procedural conformance gate (#39) — "grounding for actions".
//
// checkConformance is a pure adjudicator, the action-side twin of kcp-agent's
// groundAnswer: an observed action is a member of the loaded skill's declared
// action_scope, or it is surfaced as a gap and held. The proxy wires that
// verdict to the audit log (a correlation-stamped conformance_verdict) and to
// the approval machinery (a pending ticket carrying the failed verdict), and
// holds the call fail-closed — exactly like a below-threshold confidence.

import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { checkConformance, type ActionScope, type ObservedAction } from "../src/conformance.js";
import { HarnessProxy } from "../src/proxy.js";
import { InMemoryAuditLog } from "../src/audit.js";
import type { GovernancePolicy, GovernedDomain, HarnessConfig } from "../src/config.js";

// -- Pure function: in-scope passes, out-of-scope holds, no-scope fails closed --

describe("checkConformance — pure adjudication", () => {
  const scope: ActionScope = { tools: ["Bash", "Read"], paths: ["infra/", "docs/"], capabilities: ["deploy"] };

  it("passes an action whose tool and path are both within scope", () => {
    const action: ObservedAction = { tool: "Bash", paths: ["infra/deploy.sh"] };
    const v = checkConformance(action, scope);
    expect(v.gate).toBe("conformance");
    expect(v.passed).toBe(true);
    expect(v.reason).toMatch(/within the active skill's declared action_scope/);
    expect(v.evidence?.tool).toBe("Bash");
    expect(v.evidence?.target).toBe("infra/deploy.sh");
  });

  it("passes a tool-only action when its tool is authorized and it reaches no target", () => {
    const v = checkConformance({ tool: "Bash" }, scope);
    expect(v.passed).toBe(true);
  });

  it("surfaces a gap when the tool is outside scope, naming the tool", () => {
    const v = checkConformance({ tool: "Write", paths: ["infra/deploy.sh"] }, scope);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/tool "Write" is outside the skill's authorized tools \[Bash, Read\]/);
    expect(v.evidence?.target).toBe("Write");
  });

  it("surfaces a gap when a path is outside scope, naming the violating target", () => {
    const v = checkConformance({ tool: "Read", paths: ["secrets/prod.key"] }, scope);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/target "secrets\/prod\.key" is outside the skill's authorized paths/);
    expect(v.evidence?.target).toBe("secrets/prod.key");
  });

  it("resolves ../ traversal before matching, so an escape is held", () => {
    const v = checkConformance({ tool: "Read", paths: ["infra/../secrets/prod.key"] }, scope);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/outside the skill's authorized paths/);
  });

  it("surfaces a gap when an asserted capability is outside scope", () => {
    const v = checkConformance({ tool: "Bash", capabilities: ["rotate-secrets"] }, scope);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/capability "rotate-secrets" is outside/);
  });

  it("fails closed when the scope is absent", () => {
    const v = checkConformance({ tool: "Read", paths: ["docs/x.md"] }, undefined as unknown as ActionScope);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/declares no action_scope — fail-closed/);
  });

  it("fails closed when the scope declares nothing (empty object)", () => {
    const v = checkConformance({ tool: "Read", paths: ["docs/x.md"] }, {});
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/declares no action_scope — fail-closed/);
  });

  it("does not constrain a dimension the scope omits (paths-only scope)", () => {
    const pathsOnly: ActionScope = { paths: ["docs/"] };
    // Any tool is allowed as long as the path is in scope.
    expect(checkConformance({ tool: "Write", paths: ["docs/x.md"] }, pathsOnly).passed).toBe(true);
    // A path outside the allowlist is still held.
    expect(checkConformance({ tool: "Write", paths: ["src/x.ts"] }, pathsOnly).passed).toBe(false);
  });
});

// -- Proxy integration: verdict emitted, ticket opened, call held fail-closed --

const SKILL_MANIFEST = join(import.meta.dirname ?? ".", "fixtures", "skills", "knowledge.yaml");

const policy: GovernancePolicy = { fail_closed: true, audit_all: true, max_units: 10, strict: false };

const skillDomain: GovernedDomain = {
  manifest: SKILL_MANIFEST,
  paths: ["skills/", "docs/"],
  skills: ["Skill", "kcp_skill"],
};

const proxyConfig: HarnessConfig = {
  version: "1.0",
  governance: {
    domains: [skillDomain],
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

describe("HarnessProxy — conformance gate", () => {
  let audit: InMemoryAuditLog;
  let proxy: HarnessProxy;

  beforeEach(() => {
    audit = new InMemoryAuditLog();
    proxy = new HarnessProxy({ config: proxyConfig, audit });
  });

  it("does not run the gate before any skill is loaded", async () => {
    // A governed call with no active skill is not conformance-checked.
    await call(proxy, 1, "Read", { file_path: "skills/deploy.md" });
    expect(audit.events.some((e) => e.type === "conformance_verdict")).toBe(false);
  });

  it("holds an out-of-scope action after a skill load: verdict + ticket + block", async () => {
    // deploy-skill authorizes tool Bash / path infra/. A subsequent Read is a
    // different tool — out of scope.
    await call(proxy, 1, "Skill", { skill: "deploy-skill" });
    expect(audit.events.some((e) => e.type === "skill_loaded")).toBe(true);

    const result = await call(proxy, 2, "Read", { file_path: "skills/deploy.md" });

    // (1) The call is blocked fail-closed.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/CONFORMANCE BLOCKED/);

    // (2) A conformance_verdict is emitted, blocked, naming the violating tool.
    const verdict = audit.events.find((e) => e.type === "conformance_verdict");
    expect(verdict).toBeDefined();
    expect(verdict!.outcome).toBe("blocked");
    expect(verdict!.conformance!.skillId).toBe("deploy-skill");
    expect(verdict!.conformance!.passed).toBe(false);
    expect(verdict!.conformance!.tool).toBe("Read");
    expect(verdict!.conformance!.reason).toMatch(/outside the skill's authorized tools/);

    // (3) A pending approval ticket carries the failed verdict as evidence.
    const provider = proxy.getApprovalProvider()!;
    const tickets = await provider.list();
    expect(tickets).toHaveLength(1);
    expect(tickets[0].state).toBe("pending_review");
    expect(tickets[0].request.toolName).toBe("Read");
    expect(tickets[0].request.evidence.conformance?.passed).toBe(false);
    expect(tickets[0].request.evidence.detail).toMatch(/outside the skill's authorized tools/);
    expect(verdict!.conformance!.ticketId).toBe(tickets[0].request.id);

    // approval_requested was audited too.
    expect(audit.events.some((e) => e.type === "approval_requested")).toBe(true);
  });

  it("stamps the held call's verdict and ticket with one correlation id", async () => {
    await call(proxy, 1, "Skill", { skill: "deploy-skill" });
    await call(proxy, 2, "Read", { file_path: "skills/deploy.md" });

    const verdict = audit.events.find((e) => e.type === "conformance_verdict")!;
    const requested = audit.events.find(
      (e) => e.type === "approval_requested" && e.correlationId === verdict.correlationId,
    );
    expect(verdict.correlationId).toBeTruthy();
    expect(requested).toBeDefined();
  });

  it("passes an in-scope action: verdict approved, no ticket, no block", async () => {
    // docs-viewer-skill authorizes tools Read/Grep on docs/ and skills/.
    await call(proxy, 1, "Skill", { skill: "docs-viewer-skill" });
    expect(audit.events.some((e) => e.type === "skill_loaded")).toBe(true);

    await call(proxy, 2, "Read", { file_path: "docs/deploy-runbook.md" });

    const verdict = audit.events.find((e) => e.type === "conformance_verdict");
    expect(verdict).toBeDefined();
    expect(verdict!.outcome).toBe("approved");
    expect(verdict!.conformance!.passed).toBe(true);

    // A conformant action opens no ticket.
    const tickets = await proxy.getApprovalProvider()!.list();
    expect(tickets).toHaveLength(0);
  });

  it("reuses the open ticket when an out-of-scope action is retried", async () => {
    await call(proxy, 1, "Skill", { skill: "deploy-skill" });
    await call(proxy, 2, "Read", { file_path: "skills/deploy.md" });
    await call(proxy, 3, "Read", { file_path: "skills/deploy.md" });

    const tickets = await proxy.getApprovalProvider()!.list();
    expect(tickets).toHaveLength(1);
    expect(audit.events.filter((e) => e.type === "approval_requested")).toHaveLength(1);
  });
});

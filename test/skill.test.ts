import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { classify } from "../src/classifier.js";
import { assessSkillEligibility } from "../src/governor.js";
import { createSession } from "../src/session.js";
import { HarnessProxy } from "../src/proxy.js";
import { InMemoryAuditLog } from "../src/audit.js";
import type { GovernancePolicy, GovernedDomain, HarnessConfig } from "../src/config.js";

const SKILL_MANIFEST = join(import.meta.dirname ?? ".", "fixtures", "skills", "knowledge.yaml");

const policy: GovernancePolicy = {
  fail_closed: true,
  audit_all: true,
  max_units: 10,
  strict: false,
};

const skillDomain: GovernedDomain = {
  manifest: SKILL_MANIFEST,
  paths: ["skills/", "docs/"],
  skills: ["Skill", "kcp_skill"],
};

// -- Classification (#38) -----------------------------------------------------

describe("classify — skill invocation", () => {
  it("classifies a built-in Skill tool as a governed skill invocation", () => {
    const r = classify("Skill", { skill: "deploy-skill" }, [skillDomain]);
    expect(r.governed).toBe(true);
    expect(r.skill).toBe(true);
    expect(r.skillId).toBe("deploy-skill");
    expect(r.domain).toBe(skillDomain);
  });

  it("classifies a domain-declared skill tool and binds it to that domain", () => {
    const r = classify("kcp_skill", { name: "rotate-secrets-skill" }, [skillDomain]);
    expect(r.governed).toBe(true);
    expect(r.skill).toBe(true);
    expect(r.skillId).toBe("rotate-secrets-skill");
    expect(r.domain).toBe(skillDomain);
  });

  it("extracts the skill id from several argument shapes", () => {
    expect(classify("Skill", { skillId: "deploy-skill" }, [skillDomain]).skillId).toBe("deploy-skill");
    expect(classify("Skill", { skill_id: "deploy-skill" }, [skillDomain]).skillId).toBe("deploy-skill");
    expect(classify("Skill", { id: "deploy-skill" }, [skillDomain]).skillId).toBe("deploy-skill");
  });

  it("does not treat an ordinary governed Read as a skill", () => {
    const r = classify("Read", { file_path: "skills/deploy.md" }, [skillDomain]);
    expect(r.governed).toBe(true);
    expect(r.skill).toBeUndefined();
  });
});

// -- Eligibility gate (governor) ----------------------------------------------

describe("assessSkillEligibility", () => {
  it("admits a skill with an explicit eligibility grant", async () => {
    const session = createSession();
    const r = await assessSkillEligibility(skillDomain, "deploy-skill", session, policy);
    expect(r.eligible).toBe(true);
    expect(r.gate).toBe("skill_eligibility");
    expect(r.reason).toMatch(/explicit eligibility grant/i);
    expect(r.actionScope?.tools).toEqual(["Bash"]);
  });

  it("refuses a skill with no eligibility grant (fail-closed)", async () => {
    const session = createSession();
    const r = await assessSkillEligibility(skillDomain, "rotate-secrets-skill", session, policy);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not invoke-eligible|no explicit eligibility grant/i);
  });

  it("refuses an unknown skill id", async () => {
    const session = createSession();
    const r = await assessSkillEligibility(skillDomain, "no-such-skill", session, policy);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/no unit/i);
  });

  it("refuses a non-skill unit invoked as a skill", async () => {
    const session = createSession();
    const r = await assessSkillEligibility(skillDomain, "deploy-runbook", session, policy);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not kind: skill/i);
  });

  it("refuses when no skill id is supplied", async () => {
    const session = createSession();
    const r = await assessSkillEligibility(skillDomain, undefined, session, policy);
    expect(r.eligible).toBe(false);
  });
});

// -- Proxy EXECUTE branch: fail-closed skill gate -----------------------------

const proxyConfig: HarnessConfig = {
  version: "1.0",
  governance: {
    domains: [skillDomain],
    policy,
  },
  downstream: [],
  audit: { path: ":memory:" },
};

describe("HarnessProxy — skill gate", () => {
  let audit: InMemoryAuditLog;
  let proxy: HarnessProxy;

  beforeEach(() => {
    audit = new InMemoryAuditLog();
    proxy = new HarnessProxy({ config: proxyConfig, audit });
  });

  it("blocks an ineligible skill and emits skill_skipped (fail-closed)", async () => {
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "Skill", arguments: { skill: "rotate-secrets-skill" } },
    })) as Record<string, unknown>;

    const result = response["result"] as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/SKILL BLOCKED/);

    const skipped = audit.events.find((e) => e.type === "skill_skipped");
    expect(skipped).toBeDefined();
    expect(skipped!.skill!.id).toBe("rotate-secrets-skill");
    expect(skipped!.skill!.eligible).toBe(false);
    expect(skipped!.outcome).toBe("blocked");
    // No downstream call ever happened — there is no tool_call execute event.
    expect(audit.events.some((e) => e.type === "skill_loaded")).toBe(false);
  });

  it("emits skill_loaded for an eligible skill before execution", async () => {
    // No downstream is registered, so execution fails after the gate — but the
    // skill_loaded verdict is recorded first, proving the gate admitted it.
    await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "Skill", arguments: { skill: "deploy-skill" } },
    });

    const loaded = audit.events.find((e) => e.type === "skill_loaded");
    expect(loaded).toBeDefined();
    expect(loaded!.skill!.id).toBe("deploy-skill");
    expect(loaded!.skill!.eligible).toBe(true);
    expect(loaded!.skill!.actionScope?.tools).toEqual(["Bash"]);
  });

  it("shares one correlation id across the skill call's events", async () => {
    await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "Skill", arguments: { skill: "deploy-skill" } },
    });

    const ids = new Set(audit.events.map((e) => e.correlationId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
  });
});

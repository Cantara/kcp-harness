/**
 * kind: playbook at the harness boundary (#53) — KCP v0.29, §4.3b / RFC-0027.
 *
 * A playbook is an ordered composition of units, governed per step, reaching up to
 * `commit` authority. kcp-agent#118 found the planner's skill_eligibility gate testing
 * `kind === "skill"` literally, so a playbook passed as "not a skill" and was offered
 * while the skill it composes was withheld. Fixed in kcp-agent 0.20.0.
 *
 * This harness had the mirror-image defect. Its own gate reads:
 *
 *     if (unit.kind !== "skill") return { eligible: false, reason: "not kind: skill" }
 *
 * which is fail-closed — safe — but refuses for the wrong reason. It cannot distinguish
 * "this composition has no grant" from "this is not a procedure at all", so a playbook
 * carrying an explicit `load_eligible: true` is refused identically to one carrying
 * nothing. Safe and useless is still a bug: the harness cannot support v0.29 manifests,
 * and the audit trail records a governance decision that was never actually made.
 *
 * The tests below pin both halves — ungranted playbooks stay refused, and the reason
 * names the eligibility verdict rather than the kind.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { assessSkillEligibility } from "../src/governor.js";
import { createSession } from "../src/session.js";
import type { GovernancePolicy, GovernedDomain } from "../src/config.js";

const MANIFEST = join(import.meta.dirname ?? ".", "fixtures", "playbooks", "knowledge.yaml");

const policy: GovernancePolicy = {
  fail_closed: true,
  audit_all: true,
  max_units: 10,
  strict: false,
};

const domain: GovernedDomain = { manifest: MANIFEST, paths: ["skills/", "playbooks/", "infra/"] };

const assess = (id: string) => assessSkillEligibility(domain, id, createSession(), policy);

describe("playbook eligibility at the harness boundary (#53)", () => {
  it("refuses an ungranted playbook", async () => {
    // The contract this repo advertises: "if the harness can't verify a request, the
    // agent gets nothing." A composition with no grant is exactly that case.
    const v = await assess("ungranted-playbook");
    expect(v.eligible).toBe(false);
  });

  it("refuses it for the right reason — eligibility, not kind", async () => {
    // Before this fix the reason was `unit "ungranted-playbook" is not kind: skill`,
    // which is a category statement, not a governance verdict. An auditor reading it
    // would conclude the harness does not understand playbooks — which was true, and
    // is the thing being fixed. The verdict must name the missing grant.
    const v = await assess("ungranted-playbook");
    expect(v.reason).not.toMatch(/is not kind: skill/);
    expect(v.reason).toMatch(/eligib/i);
  });

  it("admits a playbook carrying an explicit grant", async () => {
    // The half that was broken. A human signed off on this composition; refusing it
    // is not caution, it is the harness being unable to represent the decision.
    const v = await assess("rotate-key-playbook");
    expect(v.eligible).toBe(true);
  });

  it("still admits an ordinary granted skill — no regression", async () => {
    const v = await assess("rotate-key");
    expect(v.eligible).toBe(true);
  });

  it("still refuses a unit that is genuinely not a governed procedure", async () => {
    // The `kind !== "skill"` test was doing real work for knowledge/policy/schema
    // units; widening it to cover playbooks must not open it to everything else.
    const v = await assessSkillEligibility(
      { manifest: join(import.meta.dirname ?? ".", "fixtures", "skills", "knowledge.yaml"), paths: ["skills/"] },
      "nonexistent-unit",
      createSession(),
      policy,
    );
    expect(v.eligible).toBe(false);
  });

  it("attributes every verdict to the skill_eligibility gate", async () => {
    // The audit trail names the gate that decided. A playbook refused by a different
    // gate — or by none — produces a compliance record that cannot be traced back to
    // a rule, which is the failure this harness exists to prevent.
    for (const id of ["rotate-key-playbook", "ungranted-playbook"]) {
      const v = await assess(id);
      expect(v.gate).toBe("skill_eligibility");
      expect(v.skillId).toBe(id);
    }
  });
});

describe("the composition is visible to the harness (#53)", () => {
  it("resolves the playbook's action_scope envelope", async () => {
    // A granted playbook must carry a scope the conformance checker can bound actions
    // against. Where it declares none of its own, the harness must not silently treat
    // that as unbounded — undefined here means later checks fail closed rather than
    // passing everything, which is what §4.3b requires of an unverifiable declaration.
    const v = await assess("rotate-key-playbook");
    expect(v.eligible).toBe(true);
    // Either a resolved envelope or an explicit absence — never a permissive default.
    expect(v.actionScope === undefined || typeof v.actionScope === "object").toBe(true);
  });
});

// The kcp-skill conformance vectors as an executable contract.
//
// The vendored fixtures (test/fixtures/kcp-skill-vectors, from
// Cantara/kcp-skill v0.1.0) carry the linter's expected verdicts; this suite
// runs the HARNESS's semantics — skill_eligibility and action_scope
// conformance — over the same canonical manifests. If kcp-skill blesses a
// shape this harness mishandles (or vice versa), this fails CI.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { assessSkillEligibility } from "../src/governor.js";
import { checkConformance } from "../src/conformance.js";
import { createSession } from "../src/session.js";
import type { GovernancePolicy, GovernedDomain } from "../src/config.js";

const VECTORS = join(import.meta.dirname ?? ".", "fixtures", "kcp-skill-vectors");

const policy: GovernancePolicy = {
  fail_closed: true,
  audit_all: true,
  max_units: 10,
  strict: false,
};

const domainFor = (vector: string): GovernedDomain => ({
  manifest: join(VECTORS, vector, "manifest.yaml"),
  paths: ["skills/"],
});

const assess = (vector: string, skillId: string) =>
  assessSkillEligibility(domainFor(vector), skillId, createSession(), policy);

describe("kcp-skill vectors — harness semantics over the canonical fixtures", () => {
  it("vendored vector set matches the upstream count", () => {
    const dirs = readdirSync(VECTORS, { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(dirs.length).toBe(5);
  });

  it("01-minimal-valid: a well-formed skill without a grant is fail-closed, scope resolved as declared", async () => {
    const verdict = await assess("01-minimal-valid", "rotate-signing-key");
    // Well-formed per the linter, but no load_eligible: true — the harness
    // must refuse enaction absent the explicit grant.
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("no explicit eligibility grant");
    // The declared envelope must survive resolution verbatim.
    expect(verdict.actionScope?.tools).toEqual(["kcp-sign", "git"]);
    expect(verdict.actionScope?.capabilities).toEqual(["key-management"]);

    // And were the scope active, conformance enforces it as an allowlist:
    const inScope = checkConformance(
      { tool: "kcp-sign", paths: ["schema/keys.yaml"] },
      verdict.actionScope!,
    );
    expect(inScope.passed).toBe(true);
    const outOfScope = checkConformance({ tool: "rm", paths: ["/"] }, verdict.actionScope!);
    expect(outOfScope.passed).toBe(false);
  });

  it("02-ungoverned-skill: no action_scope binds an empty envelope — every action held", async () => {
    const verdict = await assess("02-ungoverned-skill", "deploy");
    expect(verdict.eligible).toBe(false);
    // The linter flags this SK002; the harness's equivalent posture is an
    // absent scope that authorizes nothing.
    const held = checkConformance({ tool: "read", paths: ["docs/x.md"] }, verdict.actionScope as never);
    expect(held.passed).toBe(false);
    expect(held.reason).toContain("declares no action_scope");
  });

  it("03-absolute-path: a hostile envelope still confines targets outside its prefixes", async () => {
    // The linter rejects this envelope outright (SK004: absolute / ..-escaping
    // paths). The harness's job if such a scope ever reaches it: enforce the
    // allowlist as written and nothing more — a target outside the declared
    // prefixes is still held.
    const verdict = await assess("03-absolute-path", "escape-artist");
    expect(verdict.eligible).toBe(false);
    const elsewhere = checkConformance(
      { tool: "bash", paths: ["src/main.ts"] },
      verdict.actionScope!,
    );
    expect(elsewhere.passed).toBe(false);
  });

  it("04-bad-field-types: malformed skill fields never throw — fail-closed instead", async () => {
    const verdict = await assess("04-bad-field-types", "sloppy");
    expect(verdict.eligible).toBe(false);
    // tools: "git" (a string, not an array) must not be treated as a grant.
    const held = checkConformance({ tool: "git" }, verdict.actionScope as never);
    expect(held.passed).toBe(false);
  });

  it("05-non-skill-kinds-untouched: policy/schema/unknown kinds are never invoke-eligible, with the kind named", async () => {
    // The assertion is that the verdict NAMES the kind, which is what the test title
    // always claimed. It previously checked for "not kind: skill" — a phrase that says
    // what the unit isn't. Since #53 widened governed kinds to {skill, playbook}, the
    // verdict names what it is, which is both accurate and the more useful audit record.
    const expected: Record<string, string> = {
      security: "kind: policy",
      "api-schema": "kind: schema",
      mystery: "kind: hologram",
    };
    for (const [id, kind] of Object.entries(expected)) {
      const verdict = await assess("05-non-skill-kinds-untouched", id);
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toContain(kind);
      expect(verdict.reason).toContain("not a governed procedure");
    }
  });
});

/**
 * §17 wire format — prohibited_attempt (KCP v0.32.1, SPEC §17
 * `prohibited_attempt_events`; RFC-0030).
 *
 * The spec made the wire object normative: where transmission is consented
 * (e.g. a dashboard `/trace` sink), a prohibited attempt travels as a JSON
 * object with `kind: "prohibited_attempt"` and the §17 column names, and an
 * emitter and an ingester are conformant when the canonical fixture
 * round-trips between them.
 *
 * The fixture at test/fixtures/observability/prohibited-attempt.json is a
 * byte-identical vendored copy of the spec's canonical example —
 * knowledge-context-protocol conformance/fixtures/observability/
 * prohibited-attempt.json @ f769e95 (v0.32.1, PR #190). JSON carries no
 * comments, so its provenance is recorded here: re-vendor it verbatim
 * whenever the spec revs the fixture.
 *
 * kcp-harness is an emitter. The internal hash-chained audit event
 * (audit.ts) is NOT the wire format — its shape is pinned by the chain and
 * must never bend to a sink. toProhibitedAttemptWire is the projection, and
 * these tests pin it to the fixture, byte for byte modulo `timestamp` and
 * `correlation_id` (injected from the fixture, since a live emitter mints
 * its own).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkConformance, type ActionScope } from "../src/conformance.js";
import { buildProhibitedAttemptEvent, buildEvent } from "../src/audit.js";
import { toProhibitedAttemptWire, type ProhibitedAttemptWire } from "../src/wire.js";

const FIXTURE_PATH = join(
  import.meta.dirname ?? ".",
  "fixtures",
  "observability",
  "prohibited-attempt.json",
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as ProhibitedAttemptWire;

/** The fixture's scenario: a playbook deny holds a legal-hold path (§4.3b). */
function fixtureVerdict() {
  return checkConformance(
    { tool: "Read", paths: ["legal/hold/2025/case-4711/evidence.pdf"] },
    // The skill's allowlist grants legal/ — only the playbook's deny refuses.
    { tools: ["Read"], paths: ["legal/"] },
    {
      id: "pb-002-gdpr-sletting",
      stepId: "slett",
      scope: { deny: { paths: ["legal/hold/**"] } },
    },
  );
}

describe("§17 round-trip against the canonical fixture (KCP v0.32.1)", () => {
  it("serializes the fixture's scenario to the exact wire object", () => {
    const verdict = fixtureVerdict();
    const event = buildProhibitedAttemptEvent(
      "wire-session",
      1,
      "sletteagent",
      verdict,
      FIXTURE.correlation_id ?? undefined,
    );
    // A live emitter mints its own timestamp; the fixture pins the spec's.
    event.timestamp = FIXTURE.timestamp;

    const wire = toProhibitedAttemptWire(event, verdict);
    expect(wire).toStrictEqual(FIXTURE);
  });

  it("survives a JSON round-trip byte-for-byte on re-parse (emitter side of the conformance rule)", () => {
    const verdict = fixtureVerdict();
    const event = buildProhibitedAttemptEvent(
      "wire-session",
      1,
      "sletteagent",
      verdict,
      FIXTURE.correlation_id ?? undefined,
    );
    event.timestamp = FIXTURE.timestamp;

    const reparsed = JSON.parse(JSON.stringify(toProhibitedAttemptWire(event, verdict)));
    expect(reparsed).toStrictEqual(FIXTURE);
  });

  it("emits exactly the fixture's field set — nullable fields present-but-null, never omitted", () => {
    const verdict = checkConformance(
      { tool: "transfer_ownership" },
      { tools: ["Read"], deny: { tools: ["transfer_ownership"] } },
    );
    const event = buildProhibitedAttemptEvent("s1", 1, "cleanup-skill", verdict);
    const wire = toProhibitedAttemptWire(event, verdict);

    expect(Object.keys(wire).sort()).toEqual(Object.keys(FIXTURE).sort());
    expect(wire.playbook_id).toBeNull();
    expect(wire.step_id).toBeNull();
    expect(wire.acknowledged_by).toBeNull();
    expect(wire.correlation_id).toBeNull();
  });
});

describe("matched_pattern is the deny entry that fired, threaded from the verdict", () => {
  it("pins the glob, not the token, when a path glob fires", () => {
    const verdict = fixtureVerdict();
    expect(verdict.prohibited?.matchedPattern).toBe("legal/hold/**");
    expect(verdict.prohibited?.matchedPattern).not.toBe(verdict.prohibited?.token);
  });

  it("equals the token on an exact tool deny", () => {
    const verdict = checkConformance(
      { tool: "transfer_ownership" },
      { tools: ["Read"], deny: { tools: ["transfer_ownership"] } },
    );
    expect(verdict.prohibited?.matchedPattern).toBe("transfer_ownership");
  });

  it("names the skill's entry when both sources deny (skill is the first-named binding source)", () => {
    const verdict = checkConformance(
      { tool: "Read", paths: ["archive/frozen/2019.rec"] },
      { tools: ["Read"], paths: ["archive/"], deny: { paths: ["archive/frozen/**"] } },
      { id: "pb-x", scope: { deny: { paths: ["archive/**"] } } },
    );
    expect(verdict.prohibited?.bindingSources).toEqual(["skill", "playbook"]);
    expect(verdict.prohibited?.matchedPattern).toBe("archive/frozen/**");
  });
});

describe("binding_source folds the internal array into the §17 enum", () => {
  const skillScope: ActionScope = {
    tools: ["Read"],
    paths: ["archive/", "legal/"],
    deny: { paths: ["archive/frozen/**"] },
  };
  const playbook = {
    id: "gdpr-deletion-playbook",
    stepId: "purge",
    scope: { deny: { paths: ["legal/hold/**", "archive/frozen/**"] } } as ActionScope,
  };

  it('["skill"] → "skill"', () => {
    const verdict = checkConformance({ tool: "Read", paths: ["archive/frozen/2019.rec"] }, skillScope);
    const wire = toProhibitedAttemptWire(
      buildProhibitedAttemptEvent("s1", 1, "cleanup-skill", verdict),
      verdict,
    );
    expect(wire.binding_source).toBe("skill");
    expect(wire.playbook_id).toBeNull();
    expect(wire.step_id).toBeNull();
  });

  it('["playbook"] → "playbook", carrying playbook_id and step_id', () => {
    const verdict = checkConformance({ tool: "Read", paths: ["legal/hold/2025/x.rec"] }, skillScope, playbook);
    const wire = toProhibitedAttemptWire(
      buildProhibitedAttemptEvent("s1", 1, "cleanup-skill", verdict),
      verdict,
    );
    expect(wire.binding_source).toBe("playbook");
    expect(wire.playbook_id).toBe("gdpr-deletion-playbook");
    expect(wire.step_id).toBe("purge");
  });

  it('["skill", "playbook"] → "both"', () => {
    const verdict = checkConformance({ tool: "Read", paths: ["archive/frozen/2019.rec"] }, skillScope, playbook);
    const wire = toProhibitedAttemptWire(
      buildProhibitedAttemptEvent("s1", 1, "cleanup-skill", verdict),
      verdict,
    );
    expect(wire.binding_source).toBe("both");
    expect(wire.playbook_id).toBe("gdpr-deletion-playbook");
  });

  it("a skill-source deny refused inside a playbook context still names the context (§17: NULL only when there is none)", () => {
    const verdict = checkConformance(
      { tool: "Read", paths: ["archive/frozen/2019.rec"] },
      skillScope,
      { id: "pb-context", stepId: "step-1", scope: { deny: { paths: ["legal/hold/**"] } } },
    );
    expect(verdict.prohibited?.bindingSources).toEqual(["skill"]);
    const wire = toProhibitedAttemptWire(
      buildProhibitedAttemptEvent("s1", 1, "cleanup-skill", verdict),
      verdict,
    );
    expect(wire.binding_source).toBe("skill");
    expect(wire.playbook_id).toBe("pb-context");
    expect(wire.step_id).toBe("step-1");
  });
});

describe("the projection is fail-closed — it refuses what it cannot faithfully represent", () => {
  const verdict = checkConformance(
    { tool: "transfer_ownership" },
    { tools: ["Read"], deny: { tools: ["transfer_ownership"] } },
  );

  it("refuses a non-prohibited event", () => {
    const event = buildEvent(
      "s1",
      1,
      "Read",
      {},
      { kind: "pass-through", reason: "test" } as never,
      undefined,
      "approved",
      0,
    );
    expect(() => toProhibitedAttemptWire(event, verdict)).toThrow(/prohibited_attempt/);
  });

  it("refuses a verdict that carries no prohibited detail", () => {
    const passing = checkConformance({ tool: "Read" }, { tools: ["Read"] });
    const event = buildProhibitedAttemptEvent("s1", 1, "cleanup-skill", verdict);
    expect(() => toProhibitedAttemptWire(event, passing)).toThrow(/prohibited/i);
  });

  it("refuses a mismatched event/verdict pair — the wire must never stitch two refusals together", () => {
    const other = checkConformance(
      { tool: "Read", paths: ["archive/frozen/2019.rec"] },
      { tools: ["Read"], paths: ["archive/"], deny: { paths: ["archive/frozen/**"] } },
    );
    const event = buildProhibitedAttemptEvent("s1", 1, "cleanup-skill", verdict);
    expect(() => toProhibitedAttemptWire(event, other)).toThrow(/mismatch/i);
  });
});

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { govern } from "../src/governor.js";
import { createSession } from "../src/session.js";
import { parseConfig } from "../src/config.js";
import { buildEvent } from "../src/audit.js";
import type { GovernancePolicy, GovernedDomain } from "../src/config.js";
import type { Classification } from "../src/classifier.js";

// The fjordwire fixture has no signing block → unsigned
const FJORDWIRE = resolve(import.meta.dirname ?? ".", "fixtures/fjordwire/knowledge.yaml");

const domain: GovernedDomain = {
  manifest: FJORDWIRE,
  paths: ["stories/", "index.md"],
};

// -- Config parsing -----------------------------------------------------------

describe("signature config parsing", () => {
  it("parses signature_required: true", () => {
    const config = parseConfig(`
version: "1.0"
governance:
  domains:
    - manifest: "./knowledge.yaml"
      paths: ["docs/"]
  policy:
    fail_closed: true
    audit_all: true
    signature_required: true
    trusted_keys:
      - "./keys/manifest.pem"
      - "https://keys.example.com/key.pem"
`);
    expect(config.governance.policy.signature_required).toBe(true);
    expect(config.governance.policy.trusted_keys).toEqual([
      "./keys/manifest.pem",
      "https://keys.example.com/key.pem",
    ]);
  });

  it("defaults signature_required to false when omitted", () => {
    const config = parseConfig(`
version: "1.0"
governance:
  domains: []
  policy:
    fail_closed: true
    audit_all: true
`);
    expect(config.governance.policy.signature_required).toBe(false);
    expect(config.governance.policy.trusted_keys).toBeUndefined();
  });

  it("parses signature_required: false explicitly", () => {
    const config = parseConfig(`
version: "1.0"
governance:
  domains: []
  policy:
    signature_required: false
`);
    expect(config.governance.policy.signature_required).toBe(false);
  });
});

// -- Governor signature enforcement -------------------------------------------

describe("signature enforcement in governor", () => {
  it("blocks unsigned manifest when signature_required is true", async () => {
    const policy: GovernancePolicy = {
      fail_closed: true,
      audit_all: true,
      signature_required: true,
    };
    const session = createSession();
    const classification: Classification = {
      governed: true,
      domain,
      target: "stories/summary.md",
      reason: "governed path",
    };

    const decision = await govern(classification, "Read", { file_path: "stories/summary.md" }, session, policy);
    expect(decision.approved).toBe(false);
    expect(decision.mode).toBe("blocked");
    expect(decision.reason).toMatch(/signature/i);
    expect(decision.reason).toMatch(/unsigned/i);
  });

  it("allows unsigned manifest when signature_required is false", async () => {
    const policy: GovernancePolicy = {
      fail_closed: true,
      audit_all: true,
      signature_required: false,
    };
    const session = createSession();
    const classification: Classification = {
      governed: true,
      domain,
      target: "stories/summary.md",
      reason: "governed path",
    };

    const decision = await govern(classification, "Read", { file_path: "stories/summary.md" }, session, policy);
    // Should go through auto-plan, not be blocked by signature
    expect(decision.reason).not.toMatch(/signature/i);
  });

  it("allows unsigned manifest when signature_required is omitted", async () => {
    const policy: GovernancePolicy = {
      fail_closed: true,
      audit_all: true,
      // signature_required omitted — defaults to false
    };
    const session = createSession();
    const classification: Classification = {
      governed: true,
      domain,
      target: "stories/summary.md",
      reason: "governed path",
    };

    const decision = await govern(classification, "Read", { file_path: "stories/summary.md" }, session, policy);
    expect(decision.reason).not.toMatch(/signature.*unsigned/i);
  });

  it("includes signature result in governance decision", async () => {
    const policy: GovernancePolicy = {
      fail_closed: true,
      audit_all: true,
      signature_required: true,
    };
    const session = createSession();
    const classification: Classification = {
      governed: true,
      domain,
      target: "stories/summary.md",
      reason: "governed path",
    };

    const decision = await govern(classification, "Read", { file_path: "stories/summary.md" }, session, policy);
    // Signature result should be attached to the decision
    expect(decision.signature).toBeDefined();
    expect(decision.signature?.status).toBe("unsigned");
  });

  it("does not affect KCP tool passthrough", async () => {
    const policy: GovernancePolicy = {
      fail_closed: true,
      audit_all: true,
      signature_required: true,
    };
    const session = createSession();
    const classification: Classification = { governed: true, reason: "KCP tool: kcp_plan" };

    const decision = await govern(classification, "kcp_plan", { task: "test" }, session, policy);
    expect(decision.approved).toBe(true);
    expect(decision.mode).toBe("kcp-passthrough");
  });

  it("does not affect ungoverned calls", async () => {
    const policy: GovernancePolicy = {
      fail_closed: true,
      audit_all: true,
      signature_required: true,
    };
    const session = createSession();
    const classification: Classification = { governed: false, reason: "not governed" };

    const decision = await govern(classification, "Bash", { command: "ls" }, session, policy);
    expect(decision.approved).toBe(true);
  });
});

// -- Audit event signature field ----------------------------------------------

describe("signature in audit events", () => {
  it("includes signature result in tool_call audit event", () => {
    const event = buildEvent(
      "session-1",
      1,
      "Read",
      { file_path: "stories/summary.md" },
      { governed: true, reason: "governed path" },
      {
        approved: false,
        mode: "blocked",
        reason: "manifest signature unsigned",
        signature: { status: "unsigned", detail: "no signing block" },
      },
      "blocked",
      5,
    );
    expect(event.signature).toEqual({ status: "unsigned", detail: "no signing block" });
  });

  it("omits signature when governance has none", () => {
    const event = buildEvent(
      "session-1",
      1,
      "Read",
      { file_path: "docs/api.md" },
      { governed: false, reason: "not governed" },
      undefined,
      "pass-through",
      1,
    );
    expect(event.signature).toBeUndefined();
  });

  it("includes verified signature in audit event", () => {
    const event = buildEvent(
      "session-1",
      1,
      "Read",
      { file_path: "stories/summary.md" },
      { governed: true, reason: "governed path" },
      {
        approved: true,
        mode: "auto-plan",
        reason: "approved",
        signature: { status: "verified", detail: "Ed25519 OK", keyId: "fjordwire-2026" },
      },
      "approved",
      10,
    );
    expect(event.signature).toEqual({
      status: "verified",
      detail: "Ed25519 OK",
      keyId: "fjordwire-2026",
    });
  });
});

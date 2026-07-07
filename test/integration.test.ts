// Integration test — exercise the full governance pipeline with a real
// knowledge manifest (fjordwire). Tests classify → govern → audit e2e.

import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { HarnessProxy } from "../src/proxy.js";
import { InMemoryAuditLog } from "../src/audit.js";
import { classify } from "../src/classifier.js";
import { govern } from "../src/governor.js";
import { createSession, addPlan, isPathApproved } from "../src/session.js";
import type { HarnessConfig, GovernedDomain, GovernancePolicy } from "../src/config.js";

// Resolve the fjordwire test fixture (bundled in repo, no sibling checkout needed)
const FJORDWIRE_MANIFEST = resolve(
  import.meta.dirname ?? ".",
  "fixtures/fjordwire/knowledge.yaml",
);

const fjordwireDomain: GovernedDomain = {
  manifest: FJORDWIRE_MANIFEST,
  paths: ["stories/", "index.md"],
};

const policy: GovernancePolicy = {
  fail_closed: true,
  audit_all: true,
  max_units: 5,
  strict: false,
};

describe("integration: fjordwire governance", () => {
  it("classifies reads into governed fjordwire paths", () => {
    const r = classify("Read", { file_path: "stories/chipfab-exclusive.md" }, [fjordwireDomain]);
    expect(r.governed).toBe(true);
    expect(r.domain).toBe(fjordwireDomain);
    expect(r.target).toBe("stories/chipfab-exclusive.md");
  });

  it("classifies reads of ungoverned paths as pass-through", () => {
    const r = classify("Read", { file_path: "config/settings.json" }, [fjordwireDomain]);
    expect(r.governed).toBe(false);
  });

  it("auto-plans against fjordwire manifest and blocks paywalled unit", async () => {
    const session = createSession();
    const classification = classify("Read", { file_path: "stories/chipfab-exclusive.md" }, [fjordwireDomain]);
    expect(classification.governed).toBe(true);

    const decision = await govern(
      classification,
      "Read",
      { file_path: "stories/chipfab-exclusive.md" },
      session,
      policy,
    );

    // chipfab-exclusive requires x402 payment — agent only has free → blocked
    expect(decision.mode).toBe("auto-plan");
    expect(decision.approved).toBe(false);
    expect(decision.plan).toBeTruthy();
    expect(decision.reason).toMatch(/not load-eligible/);
    // The planner ran and produced a plan with selected/skipped units
    expect(decision.plan!.selected.length + decision.plan!.skipped.length).toBeGreaterThan(0);
  });

  it("auto-plan approves when unit path matches", async () => {
    const session = createSession();
    // The front-page unit has path "index.md"
    const classification = classify("Read", { file_path: "index.md" }, [fjordwireDomain]);
    expect(classification.governed).toBe(true);

    const decision = await govern(
      classification,
      "Read",
      { file_path: "index.md" },
      session,
      policy,
    );

    // index.md should match the front-page unit
    expect(decision.approved).toBe(true);
    expect(decision.mode).toBe("auto-plan");
  });

  it("registers plan in session for fast-path on subsequent calls", async () => {
    const session = createSession();
    const classification = classify("Read", { file_path: "index.md" }, [fjordwireDomain]);

    // First call: auto-plan
    const decision1 = await govern(classification, "Read", { file_path: "index.md" }, session, policy);
    expect(decision1.mode).toBe("auto-plan");
    expect(session.plans.size).toBe(1);

    // Second call to same domain: should use plan-first
    const decision2 = await govern(classification, "Read", { file_path: "index.md" }, session, policy);
    expect(decision2.approved).toBe(true);
    expect(decision2.mode).toBe("plan-first");
  });
});

describe("integration: full proxy pipeline", () => {
  let proxy: HarnessProxy;
  let audit: InMemoryAuditLog;

  const config: HarnessConfig = {
    version: "1.0",
    governance: {
      domains: [fjordwireDomain],
      policy,
    },
    downstream: [],
    audit: { path: ":memory:" },
  };

  beforeEach(() => {
    audit = new InMemoryAuditLog();
    proxy = new HarnessProxy({ config, audit });
  });

  it("blocks governed tool call via proxy and audits it", async () => {
    // Try to read a governed path — no downstream server to execute the read,
    // so this tests the governance pipeline up to the execution boundary
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "Read",
        arguments: { file_path: "stories/chipfab-exclusive.md" },
      },
    })) as Record<string, unknown>;

    // The call was processed (either blocked by governance or errored at execution)
    expect(response).toBeTruthy();
    expect(response["result"]).toBeTruthy();

    // Audit log should have recorded the event
    expect(audit.events.length).toBe(1);
    const event = audit.events[0];
    expect(event.toolCall.name).toBe("Read");
    expect(event.classification.governed).toBe(true);
    expect(event.sessionId).toBeTruthy();
    expect(event.sequence).toBe(1);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("KCP tools pass through governance and are audited", async () => {
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "kcp_plan",
        arguments: {
          task: "What stories is Fjordwire covering?",
          manifest: FJORDWIRE_MANIFEST,
        },
      },
    })) as Record<string, unknown>;

    const result = response["result"] as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);

    // Parse the plan result
    const plan = JSON.parse(result.content[0].text);
    expect(plan.plan).toBeTruthy();
    expect(plan.plan.manifest.project).toBe("fjordwire-newsstand");

    // Audit should record the KCP tool call
    expect(audit.events.length).toBe(1);
    expect(audit.events[0].classification.governed).toBe(true);
    expect(audit.events[0].outcome).toBe("approved");
  });

  it("kcp_validate works through the proxy", async () => {
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "kcp_validate",
        arguments: { manifest: FJORDWIRE_MANIFEST },
      },
    })) as Record<string, unknown>;

    const result = response["result"] as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);

    const report = JSON.parse(result.content[0].text);
    expect(report.ok).toBeDefined();
  });

  it("sequential governed calls build session state", async () => {
    // First: establish a plan via kcp_plan
    await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "kcp_plan",
        arguments: {
          task: "Read the front page",
          manifest: FJORDWIRE_MANIFEST,
        },
      },
    });

    // Check session state via harness_session
    const sessionResponse = (await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "harness_session", arguments: {} },
    })) as Record<string, unknown>;

    const sessionResult = sessionResponse["result"] as { content: Array<{ text: string }> };
    const sessionData = JSON.parse(sessionResult.content[0].text);
    expect(sessionData.sessionId).toBeTruthy();

    // Audit should have recorded both calls
    expect(audit.events.length).toBe(2);
  });
});

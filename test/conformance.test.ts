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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { checkConformance, type ActionScope, type ObservedAction } from "../src/conformance.js";
import { HarnessProxy } from "../src/proxy.js";
import { InMemoryAuditLog } from "../src/audit.js";
import type { GovernancePolicy, GovernedDomain, HarnessConfig } from "../src/config.js";
import { verifyPurchaseReceipt, type PurchaseReceiptPayload, type PurchaseReceiptSignature } from "../src/purchase-receipt.js";

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

// -- Spend dimension (#139): a PURCHASE is checked against action_scope.spend --

describe("checkConformance — PURCHASE spend adjudication", () => {
  const spendScope: ActionScope = {
    tools: ["purchase"],
    spend: { max_spend: 500, allowed_vendors: ["acme-supplies", "globex"], currency: "USD" },
  };

  it("passes an in-scope purchase: authorized vendor, matching currency, within max_spend", () => {
    const v = checkConformance(
      { tool: "purchase", purchase: { vendor: "acme-supplies", amount: 250, currency: "USD" } },
      spendScope,
    );
    expect(v.passed).toBe(true);
    expect(v.reason).toMatch(/within the active skill's declared action_scope/);
    // The spend envelope and the purchase are pinned into evidence.
    expect(v.evidence?.scopeSpend?.max_spend).toBe(500);
    expect(v.evidence?.purchase?.vendor).toBe("acme-supplies");
  });

  it("holds a purchase over max_spend, naming the amount and ceiling", () => {
    const v = checkConformance(
      { tool: "purchase", purchase: { vendor: "acme-supplies", amount: 900, currency: "USD" } },
      spendScope,
    );
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/purchase of 900 USD to "acme-supplies" exceeds max_spend 500 USD/);
    expect(v.evidence?.target).toBe("acme-supplies");
    expect(v.evidence?.scopeSpend?.max_spend).toBe(500);
  });

  it("holds a purchase to a vendor outside the allowlist", () => {
    const v = checkConformance(
      { tool: "purchase", purchase: { vendor: "shady-llc", amount: 100, currency: "USD" } },
      spendScope,
    );
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/vendor "shady-llc" is outside the skill's authorized vendors \[acme-supplies, globex\]/);
    expect(v.evidence?.target).toBe("shady-llc");
  });

  it("holds a purchase in a currency the scope does not allow", () => {
    const v = checkConformance(
      { tool: "purchase", purchase: { vendor: "globex", amount: 100, currency: "EUR" } },
      spendScope,
    );
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/currency mismatch: purchase in EUR, scope allows USD/);
    expect(v.evidence?.target).toBe("EUR");
  });

  it("fails closed on a purchase when the scope declares no spend envelope", () => {
    // A tools-only scope authorizes the buying tool but grants NO spend
    // authority — a buy under it is held fail-closed (#139).
    const noSpend: ActionScope = { tools: ["purchase"] };
    const v = checkConformance(
      { tool: "purchase", purchase: { vendor: "acme-supplies", amount: 10, currency: "USD" } },
      noSpend,
    );
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/declares no spend authority — fail-closed/);
    expect(v.evidence?.target).toBe("acme-supplies");

    // A wholly empty scope also fails closed, via the no-scope branch.
    const empty = checkConformance(
      { tool: "purchase", purchase: { vendor: "acme-supplies", amount: 10, currency: "USD" } },
      {},
    );
    expect(empty.passed).toBe(false);
    expect(empty.reason).toMatch(/declares no action_scope — fail-closed/);
  });

  it("checks vendor before currency before amount (first violation wins)", () => {
    // Bad vendor + bad currency + over budget → vendor is reported first.
    const v = checkConformance(
      { tool: "purchase", purchase: { vendor: "shady-llc", amount: 9000, currency: "EUR" } },
      spendScope,
    );
    expect(v.reason).toMatch(/vendor "shady-llc" is outside/);
  });

  it("does not constrain a sub-field the spend envelope omits (max_spend only)", () => {
    const capOnly: ActionScope = { tools: ["purchase"], spend: { max_spend: 100 } };
    // Any vendor / any currency is fine as long as the amount is within the cap.
    expect(
      checkConformance({ tool: "purchase", purchase: { vendor: "anyone", amount: 50, currency: "NOK" } }, capOnly).passed,
    ).toBe(true);
    expect(
      checkConformance({ tool: "purchase", purchase: { vendor: "anyone", amount: 150, currency: "NOK" } }, capOnly).passed,
    ).toBe(false);
  });

  it("makes a spend-only scope parseable (not fail-closed) so a purchase is adjudicated", () => {
    const spendOnly: ActionScope = { spend: { max_spend: 100 } };
    const v = checkConformance(
      { tool: "purchase", purchase: { vendor: "acme", amount: 500, currency: "USD" } },
      spendOnly,
    );
    // A spend-only scope IS parseable — so this is a real spend hold, not the
    // no-scope fail-closed branch.
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/exceeds max_spend 100/);
  });
});

// -- Proxy integration: verdict emitted, ticket opened, call held fail-closed --

const SKILL_MANIFEST = join(import.meta.dirname ?? ".", "fixtures", "skills", "knowledge.yaml");

const policy: GovernancePolicy = { fail_closed: true, audit_all: true, max_units: 10, strict: false };

const skillDomain: GovernedDomain = {
  manifest: SKILL_MANIFEST,
  paths: ["skills/", "docs/"],
  skills: ["Skill", "kcp_skill"],
  // `purchase` is a governed tool so a buy reaches the conformance gate (#139).
  tools: ["purchase"],
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

  it("holds an over-budget purchase: verdict + pending_review ticket + block (#139)", async () => {
    // procurement-skill authorizes tool `purchase`, allowed_vendors
    // [acme-supplies, globex], currency USD, max_spend 500.
    await call(proxy, 1, "Skill", { skill: "procurement-skill" });
    const loaded = audit.events.find((e) => e.type === "skill_loaded");
    expect(loaded).toBeDefined();

    // A 900 USD buy to an authorized vendor exceeds the 500 ceiling.
    const result = await call(proxy, 2, "purchase", {
      vendor: "acme-supplies",
      amount: 900,
      currency: "USD",
    });

    // (1) Blocked fail-closed with the spend reason.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/CONFORMANCE BLOCKED/);
    expect(result.content[0].text).toMatch(/exceeds max_spend 500 USD/);

    // (2) A blocked conformance_verdict names the over-budget buy.
    const verdict = audit.events.find((e) => e.type === "conformance_verdict");
    expect(verdict).toBeDefined();
    expect(verdict!.outcome).toBe("blocked");
    expect(verdict!.conformance!.skillId).toBe("procurement-skill");
    expect(verdict!.conformance!.passed).toBe(false);
    expect(verdict!.conformance!.reason).toMatch(/exceeds max_spend 500 USD/);

    // (3) A pending_review ticket carries the failed verdict as evidence.
    const tickets = await proxy.getApprovalProvider()!.list();
    expect(tickets).toHaveLength(1);
    expect(tickets[0].state).toBe("pending_review");
    expect(tickets[0].request.toolName).toBe("purchase");
    expect(tickets[0].request.evidence.conformance?.passed).toBe(false);
    expect(tickets[0].request.evidence.detail).toMatch(/exceeds max_spend/);
    expect(verdict!.conformance!.ticketId).toBe(tickets[0].request.id);
    expect(audit.events.some((e) => e.type === "approval_requested")).toBe(true);
  });

  it("still enforces max_spend when the manifest quotes it as a string (regression)", async () => {
    // procurement-quoted-spend-skill declares max_spend: "500" (quoted). Before
    // the fix, withSpendScope's strict `typeof === "number"` check silently
    // dropped this, so max_spend stayed undefined and checkConformance's amount
    // check never ran — an arbitrarily large purchase to an authorized vendor
    // would pass. It must now be coerced and enforced exactly like the
    // unquoted 500 case above.
    await call(proxy, 1, "Skill", { skill: "procurement-quoted-spend-skill" });
    expect(audit.events.some((e) => e.type === "skill_loaded")).toBe(true);

    const result = await call(proxy, 2, "purchase", {
      vendor: "acme-supplies",
      amount: 900,
      currency: "USD",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/CONFORMANCE BLOCKED/);
    expect(result.content[0].text).toMatch(/exceeds max_spend 500 USD/);

    const verdict = audit.events.find((e) => e.type === "conformance_verdict");
    expect(verdict!.outcome).toBe("blocked");
    expect(verdict!.conformance!.reason).toMatch(/exceeds max_spend 500 USD/);
  });

  it("emits an (unsigned) purchase_settled event for an in-scope, in-budget buy (#139)", async () => {
    // Before this fix, a conformant purchase produced only a conformance_verdict
    // — signPurchaseReceipt/buildPurchaseEvent existed but were never called
    // from the real settlement path. No governance.purchase_receipts is
    // configured on proxyConfig, so the event must still be emitted, unsigned.
    await call(proxy, 1, "Skill", { skill: "procurement-skill" });
    await call(proxy, 2, "purchase", { vendor: "acme-supplies", amount: 250, currency: "USD" });

    const settled = audit.events.find((e) => e.type === "purchase_settled");
    expect(settled).toBeDefined();
    expect(settled!.outcome).toBe("approved");
    expect(settled!.purchase?.vendor).toBe("acme-supplies");
    expect(settled!.purchase?.amount).toBe(250);
    expect(settled!.purchase?.currency).toBe("USD");
    expect(settled!.purchase?.signed).toBeUndefined();
  });

  it("does not emit purchase_settled for a held (over-budget) purchase", async () => {
    await call(proxy, 1, "Skill", { skill: "procurement-skill" });
    await call(proxy, 2, "purchase", { vendor: "acme-supplies", amount: 900, currency: "USD" });
    expect(audit.events.some((e) => e.type === "purchase_settled")).toBe(false);
  });
});

describe("HarnessProxy — signed purchase receipts (#139)", () => {
  function newEd25519Pem() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return {
      privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
  }

  it("signs the settlement receipt when governance.purchase_receipts is configured", async () => {
    const { privatePem, publicPem } = newEd25519Pem();
    const dir = mkdtempSync(join(tmpdir(), "kcp-harness-receipt-key-"));
    const keyPath = join(dir, "settling-authority.pem");
    writeFileSync(keyPath, privatePem, "utf-8");

    const audit = new InMemoryAuditLog();
    const proxy = new HarnessProxy({
      config: {
        ...proxyConfig,
        governance: { ...proxyConfig.governance, purchase_receipts: { private_key: keyPath, key_id: "authority-1" } },
      },
      audit,
    });

    await call(proxy, 1, "Skill", { skill: "procurement-skill" });
    await call(proxy, 2, "purchase", { vendor: "acme-supplies", amount: 250, currency: "USD", wallet: "treasury-1" });

    const settled = audit.events.find((e) => e.type === "purchase_settled")!;
    expect(settled.purchase?.signed).toBe(true);
    expect(settled.purchase?.keyId).toBe("authority-1");
    expect(typeof settled.purchase?.signature).toBe("string");

    // The signature must actually verify against the payload the event names —
    // a signed:true flag alone proves nothing without this. Reconstructed
    // entirely from the audit event, the way a real auditor with only the log
    // (no separate receipt store) would have to.
    const payload: PurchaseReceiptPayload = {
      id: settled.purchase!.receipt,
      vendor: settled.purchase!.vendor,
      amount: settled.purchase!.amount,
      currency: settled.purchase!.currency,
      wallet: settled.purchase!.wallet,
      timestamp: settled.purchase!.receiptTimestamp,
    };
    const signature: PurchaseReceiptSignature = {
      algorithm: "ed25519",
      value: settled.purchase!.signature!,
      publicKey: publicPem,
      keyId: settled.purchase?.keyId,
    };
    expect(await verifyPurchaseReceipt(payload, signature)).toBe(true);
  });

  it("degrades to an unsigned settlement event when the configured key is unreadable", async () => {
    const audit = new InMemoryAuditLog();
    const proxy = new HarnessProxy({
      config: {
        ...proxyConfig,
        governance: {
          ...proxyConfig.governance,
          purchase_receipts: { private_key: "/does/not/exist.pem" },
        },
      },
      audit,
    });

    await call(proxy, 1, "Skill", { skill: "procurement-skill" });
    const result = await call(proxy, 2, "purchase", { vendor: "acme-supplies", amount: 250, currency: "USD" });

    // The purchase itself is never held for a signing-key problem — it already
    // cleared conformance. (The test harness has no real downstream "purchase"
    // tool, so the call errors past the gate regardless — that's not what this
    // test is checking; a CONFORMANCE BLOCKED text would be the signal that the
    // signing problem incorrectly reached the gate itself.)
    expect(result.content[0].text).not.toMatch(/CONFORMANCE BLOCKED/);
    const settled = audit.events.find((e) => e.type === "purchase_settled");
    expect(settled).toBeDefined();
    expect(settled!.purchase?.signed).toBeUndefined();
  });
});

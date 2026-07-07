import { describe, it, expect, beforeEach } from "vitest";
import { HarnessProxy } from "../src/proxy.js";
import { InMemoryAuditLog } from "../src/audit.js";
import type { HarnessConfig } from "../src/config.js";

const testConfig: HarnessConfig = {
  version: "1.0",
  governance: {
    domains: [
      {
        manifest: "./knowledge.yaml",
        paths: ["docs/", "src/"],
      },
    ],
    policy: {
      fail_closed: true,
      audit_all: true,
      max_units: 5,
      strict: false,
    },
  },
  downstream: [],
  audit: { path: ":memory:" },
};

describe("HarnessProxy", () => {
  let proxy: HarnessProxy;
  let audit: InMemoryAuditLog;

  beforeEach(() => {
    audit = new InMemoryAuditLog();
    proxy = new HarnessProxy({ config: testConfig, audit });
  });

  it("handles initialize", async () => {
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } },
    })) as Record<string, unknown>;

    const result = response["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2025-06-18");
    const serverInfo = result["serverInfo"] as Record<string, unknown>;
    expect(serverInfo["name"]).toBe("kcp-harness");
  });

  it("handles ping", async () => {
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "ping",
    })) as Record<string, unknown>;

    expect(response["result"]).toEqual({});
  });

  it("lists tools including harness and KCP tools", async () => {
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    })) as Record<string, unknown>;

    const result = response["result"] as { tools: Array<{ name: string }> };
    const toolNames = result.tools.map((t) => t.name);

    expect(toolNames).toContain("harness_status");
    expect(toolNames).toContain("harness_session");
    expect(toolNames).toContain("kcp_plan");
    expect(toolNames).toContain("kcp_load");
    expect(toolNames).toContain("kcp_trace");
    expect(toolNames).toContain("kcp_validate");
    expect(toolNames).toContain("kcp_replay");
  });

  it("handles harness_status tool call", async () => {
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "harness_status", arguments: {} },
    })) as Record<string, unknown>;

    const result = response["result"] as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(false);

    const status = JSON.parse(result.content[0].text);
    expect(status.session.id).toBeTruthy();
    expect(status.governance.domains).toBe(1);
  });

  it("handles harness_session tool call", async () => {
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "harness_session", arguments: {} },
    })) as Record<string, unknown>;

    const result = response["result"] as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(false);

    const session = JSON.parse(result.content[0].text);
    expect(session.sessionId).toBeTruthy();
    expect(session.plans).toEqual({});
  });

  it("silently ignores notifications", async () => {
    const response = await proxy.handleMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response).toBeNull();
  });

  it("returns error for unknown methods", async () => {
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "unknown/method",
    })) as Record<string, unknown>;

    expect(response["error"]).toBeTruthy();
  });

  it("blocks governed tool call when no downstream and no plan", async () => {
    const response = (await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "Read", arguments: { file_path: "docs/secret.md" } },
    })) as Record<string, unknown>;

    // The call should be governed and either blocked or errored
    // (no downstream server to forward to, and auto-plan will fail
    // because ./knowledge.yaml likely doesn't exist in test context)
    const result = response["result"] as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);

    // Audit should have recorded the event
    expect(audit.events.length).toBeGreaterThan(0);
  });

  it("audits governed tool calls", async () => {
    await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "Read", arguments: { file_path: "docs/api.md" } },
    });

    expect(audit.events.length).toBeGreaterThan(0);
    const event = audit.events[0];
    expect(event.classification.governed).toBe(true);
    expect(event.toolCall.name).toBe("Read");
  });

  it("maintains session state across calls", async () => {
    const session = proxy.getSession();
    expect(session.sequence).toBe(0);

    await proxy.handleMessage({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "harness_status", arguments: {} },
    });

    expect(session.sequence).toBe(1);
  });
});

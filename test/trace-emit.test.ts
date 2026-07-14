import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { toTraceEvent, emitTrace } from "../src/trace-emit.js";
import { parseConfig } from "../src/config.js";
import type { DecisionTrace } from "kcp-agent";

// A DecisionTrace-shaped fixture (only the fields the serializer reads).
const sampleTrace = {
  task: "access docs/x.md",
  taskTerms: ["docs", "x"],
  asOf: "2026-07-14",
  capabilities: {},
  plan: {},
  units: [
    {
      id: "u-ok", path: "docs/x.md", intent: "secret intent text", outcome: "selected", score: 0.72,
      gates: [
        { gate: "audience", passed: true, detail: "" },
        { gate: "relevance", passed: true, detail: "matched" },
      ],
    },
    {
      id: "u-no", path: "docs/y.md", intent: "another intent", outcome: "skipped", rejectedBy: "temporal",
      gates: [
        { gate: "audience", passed: true, detail: "" },
        { gate: "temporal", passed: false, detail: "superseded" },
      ],
    },
  ],
  gateSummary: [{ gate: "relevance", passed: 1, failed: 1 }],
} as unknown as DecisionTrace;

describe("toTraceEvent", () => {
  it("produces a dashboard-shaped, content-free event", () => {
    const ev = toTraceEvent(sampleTrace, {
      sessionId: "s1", project: "/app", manifest: "kb://acme", ts: "2026-07-14T00:00:00Z",
    });
    expect(ev.kind).toBe("decision_trace");
    expect(ev.session_id).toBe("s1");
    expect(ev.project).toBe("/app");
    expect(ev.manifest).toBe("kb://acme");
    expect(ev.task).toBe("access docs/x.md");
    expect(ev.as_of).toBe("2026-07-14");
    expect(ev.selected).toBe(1);
    expect(ev.skipped).toBe(1);
    expect(ev.gate_summary).toEqual([{ gate: "relevance", passed: 1, failed: 1 }]);

    const skipped = ev.units.find((u) => u.outcome === "skipped");
    expect(skipped?.rejected_by).toBe("temporal");
    const selected = ev.units.find((u) => u.outcome === "selected");
    expect(selected?.score).toBe(0.72);

    // Content-free: unit `intent` must never leak into the wire event.
    expect(JSON.stringify(ev)).not.toContain("intent");
  });
});

describe("emitTrace", () => {
  it("POSTs the event to the dashboard", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    emitTrace(`http://127.0.0.1:${port}/trace`, toTraceEvent(sampleTrace, { sessionId: "s1" }));
    await new Promise((r) => setTimeout(r, 150));
    server.close();

    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("decision_trace");
  });

  it("is fail-open: an unreachable dashboard does not throw", () => {
    expect(() => emitTrace("http://127.0.0.1:1/trace", toTraceEvent(sampleTrace, { sessionId: "s1" }))).not.toThrow();
  });
});

describe("parseConfig dashboard", () => {
  it("parses dashboard.url", () => {
    const c = parseConfig("version: '1.0'\ndashboard:\n  url: http://localhost:7734/trace\n");
    expect(c.dashboard?.url).toBe("http://localhost:7734/trace");
  });
  it("defaults to undefined when absent", () => {
    const c = parseConfig("version: '1.0'\n");
    expect(c.dashboard).toBeUndefined();
  });
});

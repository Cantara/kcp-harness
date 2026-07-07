import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { DashboardServer } from "../src/dashboard/server.js";
import type { AuditEvent } from "../src/audit.js";

const TEST_DIR = join(import.meta.dirname ?? ".", ".tmp-dashboard");
const LOG_PATH = join(TEST_DIR, "audit.jsonl");

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    timestamp: "2026-07-07T10:00:00.000Z",
    sessionId: "sess-1",
    sequence: 1,
    type: "tool_call",
    outcome: "approved",
    durationMs: 5,
    ...overrides,
  };
}

function writeLog(events: AuditEvent[]): void {
  mkdirSync(TEST_DIR, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(LOG_PATH, lines, "utf-8");
}

let server: DashboardServer;
let port: number;

// Use a random high port to avoid conflicts
function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  port = randomPort();
});

afterEach(async () => {
  if (server) await server.stop();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("DashboardServer", () => {
  it("serves the dashboard HTML at /", async () => {
    writeLog([makeEvent()]);
    server = new DashboardServer({ auditPath: LOG_PATH, port, host: "127.0.0.1" });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("KCP Harness");
    expect(html).toContain("Compliance Dashboard");
  });

  it("returns summary at /api/summary", async () => {
    writeLog([
      makeEvent({ outcome: "approved", classification: { governed: true, reason: "test" } as any }),
      makeEvent({ outcome: "blocked", sequence: 2 }),
    ]);
    server = new DashboardServer({ auditPath: LOG_PATH, port, host: "127.0.0.1" });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/api/summary`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.events).toBe(2);
    expect(data.sessions).toBe(1);
    expect(data.governed).toBe(1);
    expect(data.blocked).toBe(1);
  });

  it("returns sessions at /api/sessions", async () => {
    writeLog([
      makeEvent({ sessionId: "a" }),
      makeEvent({ sessionId: "b", sequence: 2 }),
    ]);
    server = new DashboardServer({ auditPath: LOG_PATH, port, host: "127.0.0.1" });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    const data = await res.json();
    expect(data.sessions).toHaveLength(2);
  });

  it("returns filtered events at /api/events", async () => {
    writeLog([
      makeEvent({ sessionId: "a", outcome: "approved" }),
      makeEvent({ sessionId: "a", outcome: "blocked", sequence: 2 }),
      makeEvent({ sessionId: "b", outcome: "approved", sequence: 3 }),
    ]);
    server = new DashboardServer({ auditPath: LOG_PATH, port, host: "127.0.0.1" });
    await server.start();

    // All events
    const all = await fetch(`http://127.0.0.1:${port}/api/events`);
    const allData = await all.json();
    expect(allData).toHaveLength(3);

    // Filter by session
    const sess = await fetch(`http://127.0.0.1:${port}/api/events?session=a`);
    const sessData = await sess.json();
    expect(sessData).toHaveLength(2);

    // Filter by outcome
    const blocked = await fetch(`http://127.0.0.1:${port}/api/events?outcome=blocked`);
    const blockedData = await blocked.json();
    expect(blockedData).toHaveLength(1);
  });

  it("returns 404 for unknown paths", async () => {
    writeLog([]);
    server = new DashboardServer({ auditPath: LOG_PATH, port, host: "127.0.0.1" });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it("opens SSE connection at /api/events/stream", async () => {
    writeLog([]);
    server = new DashboardServer({ auditPath: LOG_PATH, port, host: "127.0.0.1" });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/api/events/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    // Close the connection
    res.body?.cancel();
  });

  it("reports address correctly", async () => {
    writeLog([]);
    server = new DashboardServer({ auditPath: LOG_PATH, port, host: "127.0.0.1" });
    await server.start();
    expect(server.getAddress()).toBe(`http://127.0.0.1:${port}`);
  });

  it("handles query params for summary filtering", async () => {
    writeLog([
      makeEvent({ timestamp: "2026-07-01T00:00:00Z", type: "tool_call" }),
      makeEvent({ timestamp: "2026-07-10T00:00:00Z", type: "tool_call", sequence: 2 }),
    ]);
    server = new DashboardServer({ auditPath: LOG_PATH, port, host: "127.0.0.1" });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/api/summary?from=2026-07-05&to=2026-07-15`);
    const data = await res.json();
    expect(data.events).toBe(1);
  });

  it("stops cleanly", async () => {
    writeLog([]);
    server = new DashboardServer({ auditPath: LOG_PATH, port, host: "127.0.0.1" });
    await server.start();
    await server.stop();
    // After stop, fetch should fail
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      expect.unreachable("should have thrown");
    } catch {
      // Expected — server is closed
    }
  });
});

// The decision-record chain (#34) has to be reachable by whatever id the caller is holding.
//
// This proxy stores the trace-id, because deriveCorrelation reduces a traceparent to it.
// The two components that produce the other half of the chain — pi-kcp's runtime and
// kcp-agent's plan envelope — both hold the *full traceparent*. An exact-match lookup
// therefore returns undefined for the id a consumer actually has, which is the one shape
// that matters: fetching "the chain for this task" from outside this repo.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AuditReader } from "../src/audit-reader.js";
import { deriveCorrelation } from "../src/correlation.js";
import type { AuditEvent } from "../src/audit.js";

const TEST_DIR = join(import.meta.dirname ?? ".", ".tmp-chain-lookup");
const LOG_PATH = join(TEST_DIR, "test.jsonl");

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
// What this proxy actually stores, taken from its own reduction rather than hardcoded.
const STORED = deriveCorrelation({ traceparent: TRACEPARENT }).correlationId;

function writeLog(events: AuditEvent[]): void {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(LOG_PATH, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

const event = (o: Partial<AuditEvent> = {}): AuditEvent => ({
  timestamp: "2026-07-07T10:00:00.000Z",
  sessionId: "sess-1",
  sequence: 1,
  type: "tool_call",
  outcome: "approved",
  durationMs: 5,
  ...o,
});

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("decisionChain accepts either form of the id", () => {
  beforeEach(() => {
    writeLog([
      event({ sequence: 1, correlationId: STORED }),
      event({ sequence: 2, correlationId: STORED, outcome: "blocked" }),
      event({ sequence: 3, correlationId: "unrelated-chain" }),
    ]);
  });

  it("finds the chain by the stored trace-id", async () => {
    const chain = await new AuditReader(LOG_PATH).decisionChain(STORED);
    expect(chain?.events).toHaveLength(2);
  });

  // The case that was broken: the caller holds the traceparent, this proxy stored the
  // trace-id, and an exact match found nothing.
  it("finds the same chain by the full traceparent the caller holds", async () => {
    const chain = await new AuditReader(LOG_PATH).decisionChain(TRACEPARENT);
    expect(chain, "a traceparent must resolve to the chain stored under its trace-id").toBeDefined();
    expect(chain?.events).toHaveLength(2);
    expect(chain?.correlationId).toBe(STORED);
  });

  it("is case-insensitive on the hex, as W3C ids are", async () => {
    const chain = await new AuditReader(LOG_PATH).decisionChain(TRACEPARENT.toUpperCase());
    expect(chain?.events).toHaveLength(2);
  });

  it("still returns undefined for an id that is genuinely absent", async () => {
    const reader = new AuditReader(LOG_PATH);
    expect(await reader.decisionChain("00-11111111111111111111111111111111-2222222222222222-01")).toBeUndefined();
    expect(await reader.decisionChain("no-such-chain")).toBeUndefined();
  });

  // A non-traceparent id must keep matching literally: chains minted by randomUUID when no
  // traceparent arrives are stored as-is, and reducing them would lose them.
  it("matches a non-traceparent correlation id literally", async () => {
    const chain = await new AuditReader(LOG_PATH).decisionChain("unrelated-chain");
    expect(chain?.events).toHaveLength(1);
  });

  it("never widens a lookup into an unrelated chain", async () => {
    const chain = await new AuditReader(LOG_PATH).decisionChain(TRACEPARENT);
    expect(chain?.events.every((e) => e.correlationId === STORED)).toBe(true);
  });
});

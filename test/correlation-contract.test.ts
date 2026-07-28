// The correlation reduction is a cross-repo contract, not an internal detail.
//
// A composing runtime (pi-kcp) records the full W3C traceparent for a task; this proxy
// records the trace-id alone. Joining the two evidence trails requires knowing that, so the
// reduction is part of the public API and is pinned here. If it changes, the spine that
// stitches planner + proxy + approval verdicts into one chain (kcp-harness#34) breaks
// quietly, and a quiet break in an audit trail is the worst kind.

import { describe, expect, it } from "vitest";
import { deriveCorrelation, parseTraceparent, traceparentFromArgs } from "../src/index.js";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

describe("the correlation reduction is public and pinned", () => {
  it("reduces an incoming traceparent to its trace-id", () => {
    expect(deriveCorrelation({ traceparent: TRACEPARENT }).correlationId).toBe(TRACE_ID);
  });

  it("keeps the caller's span as the parent", () => {
    expect(deriveCorrelation({ traceparent: TRACEPARENT }).parentId).toBe(SPAN_ID);
  });

  it("accepts the traceparent under MCP's _meta as well as at the top level", () => {
    expect(traceparentFromArgs({ _meta: { traceparent: TRACEPARENT } })).toBe(TRACEPARENT);
    expect(traceparentFromArgs({ traceparent: TRACEPARENT })).toBe(TRACEPARENT);
  });

  it("mints a fresh id when no traceparent arrives, rather than correlating unrelated calls", () => {
    const a = deriveCorrelation({});
    const b = deriveCorrelation({});
    expect(a.correlationId).not.toBe(b.correlationId);
    expect(a.parentId).toBeUndefined();
  });

  it("rejects a malformed traceparent instead of deriving a key from it", () => {
    expect(parseTraceparent("not-a-traceparent")).toBeUndefined();
    // A garbage header must not silently become a correlation id shared by every call
    // that carried it.
    expect(deriveCorrelation({ traceparent: "garbage" }).correlationId).not.toBe("garbage");
  });
});

import { describe, it, expect } from "vitest";
import {
  parseTraceparent,
  traceparentFromArgs,
  deriveCorrelation,
} from "../src/correlation.js";

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

describe("parseTraceparent", () => {
  it("parses a valid W3C traceparent into trace-id + parent span-id", () => {
    expect(parseTraceparent(VALID)).toEqual({ traceId: TRACE_ID, parentId: SPAN_ID });
  });

  it("is case-insensitive and trims", () => {
    expect(parseTraceparent(`  ${VALID.toUpperCase()}  `)).toEqual({ traceId: TRACE_ID, parentId: SPAN_ID });
  });

  it("rejects malformed values", () => {
    expect(parseTraceparent("not-a-traceparent")).toBeUndefined();
    expect(parseTraceparent("00-tooshort-00f067aa0ba902b7-01")).toBeUndefined();
    expect(parseTraceparent(42)).toBeUndefined();
    expect(parseTraceparent(undefined)).toBeUndefined();
  });

  it("rejects the forbidden all-ones version", () => {
    expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeUndefined();
  });

  it("rejects all-zero trace-id or span-id (spec: MUST NOT trust)", () => {
    expect(parseTraceparent(`00-${"0".repeat(32)}-${SPAN_ID}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE_ID}-${"0".repeat(16)}-01`)).toBeUndefined();
  });
});

describe("traceparentFromArgs", () => {
  it("reads a top-level traceparent argument", () => {
    expect(traceparentFromArgs({ traceparent: VALID })).toBe(VALID);
  });

  it("reads traceparent from the MCP _meta envelope", () => {
    expect(traceparentFromArgs({ _meta: { traceparent: VALID } })).toBe(VALID);
  });

  it("returns undefined when absent", () => {
    expect(traceparentFromArgs({ file_path: "docs/x.md" })).toBeUndefined();
  });
});

describe("deriveCorrelation", () => {
  it("reuses an incoming traceparent: trace-id → correlation, span-id → parent", () => {
    const c = deriveCorrelation({ traceparent: VALID });
    expect(c.correlationId).toBe(TRACE_ID);
    expect(c.parentId).toBe(SPAN_ID);
  });

  it("mints a fresh correlation id when no valid traceparent is present", () => {
    const c = deriveCorrelation({ file_path: "docs/x.md" });
    expect(c.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.parentId).toBeUndefined();
  });

  it("mints (does not reuse) when the traceparent is malformed", () => {
    const c = deriveCorrelation({ traceparent: "garbage" });
    expect(c.correlationId).not.toBe("garbage");
    expect(c.parentId).toBeUndefined();
  });
});

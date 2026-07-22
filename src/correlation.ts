// Decision-record correlation — one id per intercepted tool call (#34).
//
// Every tool call the harness processes produces a chain of verdicts (govern →
// grounding → confidence → approval → skill). A single correlation id ties that
// chain together in the audit log so a reviewer can reconstruct exactly which
// verdicts belong to which action.
//
// Per the KCP spec (§3.2 propagation / §17 observability), the harness reuses an
// incoming W3C `traceparent` when the caller supplies one — its 32-hex trace-id
// becomes the correlation id and its span-id becomes the parent — so the
// harness's records stitch into the caller's distributed trace. Absent a valid
// traceparent, a fresh id is minted.

import { randomUUID } from "node:crypto";

/** A derived correlation: the chain id, and the upstream span it descends from. */
export interface Correlation {
  /** The decision-record chain id shared by every verdict for one tool call. */
  correlationId: string;
  /** The W3C parent span-id, when reused from an incoming traceparent. */
  parentId?: string;
}

/**
 * W3C Trace Context `traceparent`:
 *   version "-" trace-id "-" parent-id "-" trace-flags
 *   00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 * We accept any 2-hex version (the spec forbids only the all-ones sentinel).
 */
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_PARENT_ID = "0".repeat(16);

/**
 * Parse a W3C traceparent header. Returns the trace-id and parent span-id, or
 * undefined when the value is malformed or carries the invalid all-zero ids
 * (which the spec says receivers MUST NOT trust).
 */
export function parseTraceparent(value: unknown): { traceId: string; parentId: string } | undefined {
  if (typeof value !== "string") return undefined;
  const m = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!m) return undefined;
  const [, version, traceId, parentId] = m;
  if (version === "ff") return undefined; // forbidden version
  if (traceId === ZERO_TRACE_ID || parentId === ZERO_PARENT_ID) return undefined;
  return { traceId, parentId };
}

/**
 * Find an incoming traceparent in a tool call's arguments. Accepts either a
 * top-level `traceparent` argument or one carried under MCP's `_meta` envelope
 * (`_meta.traceparent`), matching how W3C headers ride along a JSON-RPC call.
 */
export function traceparentFromArgs(args: Record<string, unknown>): unknown {
  if (typeof args["traceparent"] === "string") return args["traceparent"];
  const meta = args["_meta"];
  if (meta && typeof meta === "object" && "traceparent" in meta) {
    return (meta as Record<string, unknown>)["traceparent"];
  }
  return undefined;
}

/**
 * Derive the correlation for a tool call: reuse an incoming W3C traceparent
 * (trace-id → correlation id, span-id → parent), else mint a fresh id.
 */
export function deriveCorrelation(args: Record<string, unknown>): Correlation {
  const parsed = parseTraceparent(traceparentFromArgs(args));
  if (parsed) {
    return { correlationId: parsed.traceId, parentId: parsed.parentId };
  }
  return { correlationId: randomUUID() };
}

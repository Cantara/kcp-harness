// Audit reader — streaming JSONL reader with query capabilities.
//
// Reads the append-only audit log and provides filtering, summarization,
// and session indexing. This is the read counterpart to audit.ts's writer.
// Used by the compliance export (export.ts) and the dashboard (future).

import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AuditEvent, AuditEventType } from "./audit.js";

/** Filter criteria for querying audit events. */
export interface AuditFilter {
  /** Filter by session ID. */
  sessionId?: string;
  /** Filter by event type(s). */
  type?: AuditEventType | AuditEventType[];
  /** Include events from this ISO date (inclusive). */
  from?: string;
  /** Include events until this ISO date (inclusive). */
  to?: string;
  /** Filter by outcome. */
  outcome?: AuditEvent["outcome"];
}

/** Aggregate statistics from the audit log. */
export interface AuditSummary {
  /** Total sessions observed. */
  sessions: number;
  /** Total events. */
  events: number;
  /** Events targeting governed domains. */
  governed: number;
  /** Events that were blocked. */
  blocked: number;
  /** Budget exceeded events. */
  budgetExceeded: number;
  /** Temporal drift events. */
  drifts: number;
  /** Signature-blocked events. */
  signatureBlocked: number;
  /** Date range of the log. */
  dateRange: { first: string; last: string };
}

/** Session summary in the index. */
export interface SessionEntry {
  id: string;
  startedAt: string;
  endedAt?: string;
  events: number;
  governed: number;
  blocked: number;
}

/** Index of all sessions in the audit log. */
export interface SessionIndex {
  sessions: SessionEntry[];
}

/**
 * A decision-record chain (#34): every audit event sharing one correlation id —
 * the full verdict cascade (govern → grounding → confidence → approval → skill)
 * for a single intercepted tool call, in sequence order.
 */
export interface DecisionChain {
  /** The correlation id shared by every event in the chain. */
  correlationId: string;
  /** The upstream W3C parent span-id, when the chain descends from one. */
  parentId?: string;
  /** The session this chain belongs to. */
  sessionId: string;
  /** Chain events, sorted by monotonic sequence. */
  events: AuditEvent[];
  /** Whether any event in the chain was blocked. */
  blocked: boolean;
}

/** Streaming JSONL audit log reader. */
export class AuditReader {
  constructor(private readonly path: string) {}

  /** Stream all events, optionally filtered. */
  async *stream(filter?: AuditFilter): AsyncIterable<AuditEvent> {
    if (!existsSync(this.path)) return;

    const rl = createInterface({
      input: createReadStream(this.path, "utf-8"),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as AuditEvent;
        if (matchesFilter(event, filter)) {
          yield event;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  /** Read all events into memory (for small-to-medium logs). */
  async readAll(filter?: AuditFilter): Promise<AuditEvent[]> {
    const events: AuditEvent[] = [];
    for await (const event of this.stream(filter)) {
      events.push(event);
    }
    return events;
  }

  /** Get aggregate statistics. */
  async summarize(filter?: AuditFilter): Promise<AuditSummary> {
    const sessionIds = new Set<string>();
    let events = 0;
    let governed = 0;
    let blocked = 0;
    let budgetExceeded = 0;
    let drifts = 0;
    let signatureBlocked = 0;
    let first = "";
    let last = "";

    for await (const event of this.stream(filter)) {
      events++;
      sessionIds.add(event.sessionId);
      if (event.timestamp) {
        if (!first || event.timestamp < first) first = event.timestamp;
        if (!last || event.timestamp > last) last = event.timestamp;
      }
      if (event.classification?.governed) governed++;
      if (event.outcome === "blocked") blocked++;
      if (event.type === "budget_exceeded") budgetExceeded++;
      if (event.type === "temporal_drift") drifts++;
      if (event.outcome === "blocked" && event.signature?.status && event.signature.status !== "verified") {
        signatureBlocked++;
      }
    }

    return {
      sessions: sessionIds.size,
      events,
      governed,
      blocked,
      budgetExceeded,
      drifts,
      signatureBlocked,
      dateRange: { first, last },
    };
  }

  /** Get events grouped by session. */
  async sessionIndex(): Promise<SessionIndex> {
    const sessions = new Map<string, SessionEntry>();

    for await (const event of this.stream()) {
      let entry = sessions.get(event.sessionId);
      if (!entry) {
        entry = {
          id: event.sessionId,
          startedAt: event.timestamp,
          events: 0,
          governed: 0,
          blocked: 0,
        };
        sessions.set(event.sessionId, entry);
      }
      entry.events++;
      if (event.timestamp < entry.startedAt) entry.startedAt = event.timestamp;
      if (!entry.endedAt || event.timestamp > entry.endedAt) entry.endedAt = event.timestamp;
      if (event.classification?.governed) entry.governed++;
      if (event.outcome === "blocked") entry.blocked++;
      if (event.type === "session_end") entry.endedAt = event.timestamp;
    }

    return { sessions: Array.from(sessions.values()) };
  }

  /**
   * Reconstruct every decision-record chain in the log: events grouped by
   * correlation id, each chain's events sorted by sequence. Events without a
   * correlation id (pre-#34 records, or lifecycle events) are omitted — a chain
   * is defined by a shared correlation id. Optionally scoped by filter.
   */
  async chains(filter?: AuditFilter): Promise<DecisionChain[]> {
    const groups = new Map<string, DecisionChain>();

    for await (const event of this.stream(filter)) {
      const id = event.correlationId;
      if (!id) continue;
      let chain = groups.get(id);
      if (!chain) {
        chain = {
          correlationId: id,
          parentId: event.parentId,
          sessionId: event.sessionId,
          events: [],
          blocked: false,
        };
        groups.set(id, chain);
      }
      if (!chain.parentId && event.parentId) chain.parentId = event.parentId;
      chain.events.push(event);
      if (event.outcome === "blocked") chain.blocked = true;
    }

    for (const chain of groups.values()) {
      chain.events.sort((a, b) => a.sequence - b.sequence);
    }
    return Array.from(groups.values());
  }

  /**
   * Reconstruct a single decision-record chain by its correlation id — the
   * verdict cascade for one tool call, in sequence order. Returns undefined
   * when no event carries that id.
   */
  async decisionChain(correlationId: string): Promise<DecisionChain | undefined> {
    const chains = await this.chains();
    return chains.find((c) => c.correlationId === correlationId);
  }

  /** Check if the audit log file exists. */
  exists(): boolean {
    return existsSync(this.path);
  }

  /** Get file size in bytes. */
  size(): number {
    if (!this.exists()) return 0;
    return statSync(this.path).size;
  }

  /** Get the path to the audit log. */
  getPath(): string {
    return this.path;
  }
}

/** Check if an event matches the filter criteria. */
function matchesFilter(event: AuditEvent, filter?: AuditFilter): boolean {
  if (!filter) return true;

  if (filter.sessionId && event.sessionId !== filter.sessionId) return false;

  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(event.type)) return false;
  }

  if (filter.from && event.timestamp < filter.from) return false;
  if (filter.to && event.timestamp > filter.to) return false;
  if (filter.outcome && event.outcome !== filter.outcome) return false;

  return true;
}

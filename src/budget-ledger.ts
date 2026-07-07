// Budget ledger — itemized session spend tracking.
//
// The budget ledger records every cost event in the session: what was spent,
// on which unit, from which manifest, and why. It maintains a running total
// that the governor uses to enforce budget ceilings across calls.
//
// The ledger is the single source of truth for "how much did this session
// cost?" — the audit log cites it, the governor consults it, and the
// harness_budget tool exposes it.
//
// Design:
// - Append-only: entries are never modified or removed
// - Deterministic totals: running total is recomputed from entries (no drift)
// - Currency-aware: tracks spend per currency
// - Overflow-safe: rejects entries that would exceed the ceiling

/** A single spend event. */
export interface LedgerEntry {
  /** Monotonic sequence within the ledger. */
  seq: number;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** What triggered the spend. */
  source: LedgerSource;
  /** The cost. */
  cost: LedgerCost;
  /** Running total after this entry (per currency). */
  runningTotal: Record<string, number>;
}

/** What triggered a spend event. */
export interface LedgerSource {
  /** The manifest that produced the plan. */
  manifest: string;
  /** The unit that incurred the cost (if unit-level). */
  unitId?: string;
  /** The task that prompted the plan. */
  task: string;
  /** Audit sequence number for correlation. */
  auditSequence?: number;
}

/** The cost of a spend event. */
export interface LedgerCost {
  /** Amount spent. */
  amount: number;
  /** Currency (default: USDC). */
  currency: string;
  /** Payment method used. */
  method: string;
  /** Human-readable note. */
  note?: string;
}

/** Budget ceiling configuration. */
export interface BudgetCeiling {
  amount: number;
  currency: string;
}

/** Result of attempting to record a spend. */
export interface SpendResult {
  /** Whether the spend was recorded (false if it would exceed ceiling). */
  accepted: boolean;
  /** The ledger entry (if accepted). */
  entry?: LedgerEntry;
  /** Running total after this entry. */
  total: number;
  /** Remaining budget (if ceiling is set). */
  remaining?: number;
  /** Reason for rejection (if not accepted). */
  reason?: string;
}

/** Budget ledger — append-only spend tracking for a session. */
export class BudgetLedger {
  private entries: LedgerEntry[] = [];
  private totals = new Map<string, number>();
  private ceiling?: BudgetCeiling;
  private nextSeq = 1;

  constructor(ceiling?: BudgetCeiling) {
    this.ceiling = ceiling;
  }

  /** Record a spend event. Returns whether it was accepted. */
  record(source: LedgerSource, cost: LedgerCost): SpendResult {
    const currency = cost.currency || "USDC";

    // Reject negative amounts — no refunds through the ledger
    if (cost.amount < 0) {
      return {
        accepted: false,
        total: this.totals.get(currency) ?? 0,
        reason: `negative spend rejected: ${cost.amount} ${currency}`,
      };
    }

    const currentTotal = this.totals.get(currency) ?? 0;
    const newTotal = round6(currentTotal + cost.amount);

    // Check ceiling
    if (this.ceiling && currency === this.ceiling.currency) {
      if (newTotal > this.ceiling.amount + 1e-9) {
        return {
          accepted: false,
          total: currentTotal,
          remaining: round6(this.ceiling.amount - currentTotal),
          reason: `would exceed budget ceiling: ${newTotal} > ${this.ceiling.amount} ${currency}`,
        };
      }
    }

    // Accept
    this.totals.set(currency, newTotal);
    const runningTotal = Object.fromEntries(this.totals);

    const entry: LedgerEntry = {
      seq: this.nextSeq++,
      timestamp: new Date().toISOString(),
      source,
      cost: { ...cost, currency },
      runningTotal,
    };
    this.entries.push(entry);

    return {
      accepted: true,
      entry,
      total: newTotal,
      remaining: this.ceiling && currency === this.ceiling.currency
        ? round6(this.ceiling.amount - newTotal)
        : undefined,
    };
  }

  /** Record spend from a plan's projected costs (convenience). */
  recordPlanSpend(
    manifest: string,
    task: string,
    projectedSpend: number,
    currency: string,
    auditSequence?: number,
  ): SpendResult {
    return this.record(
      { manifest, task, auditSequence },
      { amount: projectedSpend, currency, method: "plan-projected", note: "from plan budget projection" },
    );
  }

  /** Record spend for a specific unit (fine-grained). */
  recordUnitSpend(
    manifest: string,
    unitId: string,
    task: string,
    amount: number,
    currency: string,
    method: string,
    auditSequence?: number,
  ): SpendResult {
    return this.record(
      { manifest, unitId, task, auditSequence },
      { amount, currency, method },
    );
  }

  /** Get the current total for a currency. */
  getTotal(currency = "USDC"): number {
    return this.totals.get(currency) ?? 0;
  }

  /** Get remaining budget (if ceiling is set). */
  getRemaining(): number | undefined {
    if (!this.ceiling) return undefined;
    return round6(this.ceiling.amount - this.getTotal(this.ceiling.currency));
  }

  /** Get all entries. */
  getEntries(): readonly LedgerEntry[] {
    return this.entries;
  }

  /** Get the ceiling configuration. */
  getCeiling(): BudgetCeiling | undefined {
    return this.ceiling;
  }

  /** Get a summary snapshot. */
  snapshot(): LedgerSnapshot {
    return {
      ceiling: this.ceiling,
      totals: Object.fromEntries(this.totals),
      remaining: this.getRemaining(),
      entryCount: this.entries.length,
      lastEntry: this.entries.length > 0 ? this.entries[this.entries.length - 1] : undefined,
    };
  }
}

/** A point-in-time snapshot of the ledger. */
export interface LedgerSnapshot {
  ceiling?: BudgetCeiling;
  totals: Record<string, number>;
  remaining?: number;
  entryCount: number;
  lastEntry?: LedgerEntry;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

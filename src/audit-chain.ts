// Audit-log hash-chaining — tamper-evidence for the append-only JSONL log.
//
// Sequence numbers alone prove nothing: an attacker who can edit the log can
// renumber it. A hash chain makes every entry commit to the exact bytes of the
// one before it. Each entry carries `prevHash` = sha256 of the previous entry's
// canonical line; the first entry's prevHash is GENESIS_HASH. Changing any byte
// of an entry changes its hash, so the NEXT entry's prevHash no longer matches —
// the break is detectable, and so is any reordering.
//
// The chain's head (the hash of the last entry) is a single value that commits
// to the whole log. The signed compliance export embeds and signs it (export.ts),
// which anchors even the final entry — the one a plain chain walk cannot pin.

import { createHash } from "node:crypto";

/** The prevHash of the first entry — a fixed 32-byte (64 hex) zero genesis. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * The canonical bytes of an audit entry are exactly the JSONL line as stored:
 * `JSON.stringify(event)` with no trailing newline. Hashing the stored line
 * (not a re-serialization) means any byte-level edit is caught.
 */
export function hashAuditLine(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

/** Result of walking an audit log's hash chain. */
export interface ChainVerification {
  /** True when every link verified from genesis to head. */
  valid: boolean;
  /** Number of entries walked. */
  entries: number;
  /** sha256 of the last entry's canonical line (the chain head), or GENESIS when empty. */
  headHash: string;
  /**
   * 1-indexed sequence position of the entry whose link broke, when invalid.
   * A tampered entry surfaces the break at the NEXT entry (whose prevHash no
   * longer matches), so `brokenAt` is that predecessor's position.
   */
  brokenAt?: number;
  /** Written reason for an invalid chain. */
  reason?: string;
}

/**
 * Walk a log's hash chain over its raw JSONL lines (in file order). Fail-closed:
 * a malformed line, a missing prevHash, or any mismatch invalidates the chain.
 */
export function verifyAuditChain(lines: string[]): ChainVerification {
  let expectedPrev = GENESIS_HASH;
  let headHash = GENESIS_HASH;
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    count++;

    let event: { prevHash?: unknown };
    try {
      event = JSON.parse(line) as { prevHash?: unknown };
    } catch {
      return { valid: false, entries: count, headHash, brokenAt: count, reason: `entry ${count} is not valid JSON` };
    }

    if (typeof event.prevHash !== "string") {
      return { valid: false, entries: count, headHash, brokenAt: count, reason: `entry ${count} has no prevHash — chain is not continuous` };
    }

    if (event.prevHash !== expectedPrev) {
      return {
        valid: false,
        entries: count,
        headHash,
        // The link that broke belongs to the predecessor whose hash no longer matches.
        brokenAt: count - 1 >= 1 ? count - 1 : count,
        reason: `entry ${count} prevHash ${event.prevHash.slice(0, 12)}… does not match the previous entry's hash ${expectedPrev.slice(0, 12)}…`,
      };
    }

    headHash = hashAuditLine(line);
    expectedPrev = headHash;
  }

  return { valid: true, entries: count, headHash };
}

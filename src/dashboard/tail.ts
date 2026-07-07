// Audit log tail — watch for new events appended to the JSONL log.
//
// Uses fs.watch + readline to tail the audit log and emit parsed events.
// Powers the SSE live-update endpoint in the dashboard.

import { createReadStream, watchFile, unwatchFile, statSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AuditEvent } from "../audit.js";

type TailHandler = (event: AuditEvent) => void;

/** Tails an append-only JSONL audit log, emitting new events. */
export class AuditTail {
  private handlers: TailHandler[] = [];
  private offset = 0;
  private running = false;

  constructor(private readonly path: string) {}

  /** Register a handler for new events. */
  on(_event: "line", handler: TailHandler): void {
    this.handlers.push(handler);
  }

  /** Start tailing from the current end of file. */
  start(): void {
    if (this.running) return;
    this.running = true;

    try {
      this.offset = statSync(this.path).size;
    } catch {
      this.offset = 0;
    }

    watchFile(this.path, { interval: 1000 }, () => {
      this.readNew();
    });
  }

  /** Stop tailing. */
  stop(): void {
    this.running = false;
    unwatchFile(this.path);
  }

  private readNew(): void {
    if (!this.running) return;

    let currentSize: number;
    try {
      currentSize = statSync(this.path).size;
    } catch {
      return;
    }

    if (currentSize <= this.offset) return;

    const stream = createReadStream(this.path, {
      encoding: "utf-8",
      start: this.offset,
    });

    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let newOffset = this.offset;

    rl.on("line", (line) => {
      newOffset += Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed) as AuditEvent;
        for (const handler of this.handlers) {
          handler(event);
        }
      } catch {
        // Skip malformed lines
      }
    });

    rl.on("close", () => {
      this.offset = newOffset;
    });
  }
}

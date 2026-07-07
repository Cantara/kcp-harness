// Dashboard server — HTTP API + static UI over the audit log.
//
// Serves the compliance dashboard on localhost. No external dependencies
// — uses Node's built-in http module. Binds to 127.0.0.1 by default
// for security (no network exposure).

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AuditReader } from "../audit-reader.js";
import type { AuditFilter } from "../audit-reader.js";
import { AuditTail } from "./tail.js";
import { renderDashboard } from "./ui.js";

/** Dashboard server options. */
export interface DashboardOptions {
  /** Path to the audit JSONL log. */
  auditPath: string;
  /** HTTP port (default: 3847). */
  port: number;
  /** Bind host (default: 127.0.0.1 — localhost only). */
  host: string;
}

/** Compliance dashboard HTTP server. */
export class DashboardServer {
  private server: Server | null = null;
  private tail: AuditTail | null = null;
  private sseClients = new Set<ServerResponse>();
  private readonly reader: AuditReader;
  private readonly options: DashboardOptions;

  constructor(options: DashboardOptions) {
    this.options = options;
    this.reader = new AuditReader(options.auditPath);
  }

  /** Start the dashboard server. */
  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));

    // Start tailing for SSE
    this.tail = new AuditTail(this.options.auditPath);
    this.tail.on("line", (event) => {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of this.sseClients) {
        try {
          client.write(data);
        } catch {
          this.sseClients.delete(client);
        }
      }
    });
    this.tail.start();

    return new Promise((resolve) => {
      this.server!.listen(this.options.port, this.options.host, () => {
        resolve();
      });
    });
  }

  /** Stop the dashboard server. */
  async stop(): Promise<void> {
    this.tail?.stop();
    for (const client of this.sseClients) {
      try { client.end(); } catch {}
    }
    this.sseClients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /** Get the server address. */
  getAddress(): string {
    return `http://${this.options.host}:${this.options.port}`;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // CORS headers for localhost
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET");

    try {
      switch (path) {
        case "/":
          return this.serveUI(res);
        case "/api/summary":
          return await this.serveSummary(url, res);
        case "/api/sessions":
          return await this.serveSessions(res);
        case "/api/events":
          return await this.serveEvents(url, res);
        case "/api/events/stream":
          return this.serveSSE(req, res);
        default:
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
      }
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  }

  private serveUI(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDashboard());
  }

  private async serveSummary(url: URL, res: ServerResponse): Promise<void> {
    const filter = parseFilterParams(url);
    const summary = await this.reader.summarize(filter);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(summary));
  }

  private async serveSessions(res: ServerResponse): Promise<void> {
    const index = await this.reader.sessionIndex();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(index));
  }

  private async serveEvents(url: URL, res: ServerResponse): Promise<void> {
    const filter = parseFilterParams(url);
    const events = await this.reader.readAll(filter);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(events));
  }

  private serveSSE(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write("retry: 5000\n\n");

    this.sseClients.add(res);

    req.on("close", () => {
      this.sseClients.delete(res);
    });
  }
}

/** Parse filter parameters from URL query string. */
function parseFilterParams(url: URL): AuditFilter | undefined {
  const session = url.searchParams.get("session") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  const outcome = url.searchParams.get("outcome") ?? undefined;

  if (!session && !type && !from && !to && !outcome) return undefined;

  return {
    sessionId: session,
    type: type as AuditFilter["type"],
    from,
    to,
    outcome: outcome as AuditFilter["outcome"],
  };
}

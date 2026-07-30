// HTTP govern endpoint — expose the adjudicator over HTTP.
//
// govern() is otherwise reachable only through node imports or the MCP stdio
// proxy. A browser page, a sidecar, or any non-node host has no way to POST a
// governance request and read the decision. This module adds a minimal
// `POST /govern` surface that does exactly one thing: take an in-memory manifest
// plus a tool/skill call, run the *existing* govern() adjudication against it,
// and return the GovernanceDecision as JSON — with permissive CORS so a browser
// can call it.
//
// It reimplements no adjudication. It builds the same inputs the proxy builds
// (classify() → a GovernedDomain over the posted manifest → govern() with the
// in-memory manifest source) and returns govern()'s verdict verbatim. Every
// error path — malformed body, bad JSON, wrong shape — fails closed: a blocked
// decision, never an approval.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { classify } from "./classifier.js";
import { govern, type GovernanceDecision, type InMemoryManifest } from "./governor.js";
import { createSession } from "./session.js";
import { DEFAULT_POLICY, type GovernancePolicy, type GovernedDomain } from "./config.js";

/**
 * The governed-domain selectors a caller declares for the posted manifest —
 * the same fields as a config `GovernedDomain`, minus `manifest` (the manifest
 * is supplied in-memory in the request body, not by path).
 */
export type GovernHttpDomain = Omit<GovernedDomain, "manifest">;

/** A governance request posted to `POST /govern`. */
export interface GovernHttpRequest {
  /** The manifest to govern against, in-memory: a parsed Manifest or `{ text, source }`. */
  manifest: InMemoryManifest;
  /** The tool call to adjudicate. */
  request: { tool: string; args?: Record<string, unknown> };
  /** Governed-domain selectors (paths/urls/tools/skills) for classification. */
  domain?: GovernHttpDomain;
  /** Policy overrides layered onto DEFAULT_POLICY (a caller may tighten, e.g. signature_required). */
  policy?: Partial<GovernancePolicy>;
}

/** The handler's result: the HTTP status and the decision to serialize as the body. */
export interface GovernHttpResult {
  status: number;
  decision: GovernanceDecision;
}

/** A fail-closed blocked decision — used for every malformed / unusable request. */
function blocked(reason: string): GovernanceDecision {
  return { approved: false, mode: "blocked", reason };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A manifest source must be a parsed manifest (has `units`) or a `{ text }` object. */
function isManifestSource(v: unknown): v is InMemoryManifest {
  if (!isRecord(v)) return false;
  if (Array.isArray((v as { units?: unknown }).units)) return true;
  return typeof (v as { text?: unknown }).text === "string";
}

/** The label a decision's reason uses for an in-memory manifest (mirrors govern's own labelling). */
function manifestLabel(m: InMemoryManifest): string {
  const src = (m as { source?: unknown }).source;
  return typeof src === "string" && src.length > 0 ? src : "in-memory manifest";
}

/**
 * Adjudicate a governance request. Pure and transport-free so it can be tested
 * directly and reused by any server. Reuses classify() + govern() exactly as
 * the proxy does — no adjudication is reimplemented here.
 *
 * Fail-closed: any shape the harness cannot turn into a real govern() call is
 * refused with a blocked decision and HTTP 400, never approved.
 */
export async function adjudicate(body: unknown): Promise<GovernHttpResult> {
  if (!isRecord(body)) {
    return { status: 400, decision: blocked("malformed govern request (fail-closed): body is not an object") };
  }

  const manifest = body["manifest"];
  if (!isManifestSource(manifest)) {
    return {
      status: 400,
      decision: blocked("malformed govern request (fail-closed): missing or invalid `manifest` (expected a parsed manifest or { text })"),
    };
  }

  const request = body["request"];
  const tool = isRecord(request) ? request["tool"] : undefined;
  if (typeof tool !== "string" || tool.length === 0) {
    return {
      status: 400,
      decision: blocked("malformed govern request (fail-closed): missing `request.tool`"),
    };
  }
  const rawArgs = isRecord(request) ? request["args"] : undefined;
  const args: Record<string, unknown> = isRecord(rawArgs) ? rawArgs : {};

  const domainSel = isRecord(body["domain"]) ? (body["domain"] as GovernHttpDomain) : {};
  const domain: GovernedDomain = { manifest: manifestLabel(manifest), ...domainSel };

  const policy: GovernancePolicy = { ...DEFAULT_POLICY, ...(isRecord(body["policy"]) ? (body["policy"] as Partial<GovernancePolicy>) : {}) };

  const classification = classify(tool, args, [domain]);
  const decision = await govern(classification, tool, args, createSession(), policy, undefined, manifest);

  return { status: 200, decision };
}

/** Options for the govern HTTP server. */
export interface GovernHttpOptions {
  /** HTTP port (0 = an OS-assigned ephemeral port). */
  port: number;
  /** Bind host (default 127.0.0.1 — localhost only unless overridden). */
  host?: string;
}

/** Read a request body up to a sane cap, fail-closed on overflow. */
function readBody(req: IncomingMessage, limit = 5 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * A minimal HTTP server exposing `POST /govern`. Opt-in — nothing starts it
 * unless a host explicitly does (CLI `govern-serve`, or embedding this class).
 * Binds localhost by default; the decision is always govern()'s, fail-closed.
 */
export class GovernHttpServer {
  private server: Server | null = null;
  private readonly host: string;
  private readonly port: number;
  private boundPort = 0;

  constructor(options: GovernHttpOptions) {
    this.port = options.port;
    this.host = options.host ?? "127.0.0.1";
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, () => {
        const addr = this.server!.address() as AddressInfo | null;
        this.boundPort = addr?.port ?? this.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  /** The address the server is listening on (with the resolved ephemeral port). */
  getAddress(): string {
    return `http://${this.host}:${this.boundPort}`;
  }

  private setCors(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setCors(res);

    // CORS preflight — browsers send this before the real POST.
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/govern") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify(blocked("method not allowed — POST a govern request")));
      return;
    }

    let body: unknown;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Fail-closed: unparseable request is a blocked decision, not an error we swallow.
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(blocked(`malformed govern request (fail-closed): ${msg}`)));
      return;
    }

    let result: GovernHttpResult;
    try {
      result = await adjudicate(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Any adjudication failure fails closed — never leak an approval on error.
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(blocked(`govern failed (fail-closed): ${msg}`)));
      return;
    }

    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.decision));
  }
}

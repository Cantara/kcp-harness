// HTTP govern endpoint — a browser / sidecar / remote host must be able to POST
// a governance request (in-memory manifest + a tool call) and get back the same
// GovernanceDecision the in-process govern() would produce. Before this, govern()
// was reachable only through node imports or the MCP stdio proxy — there was no
// HTTP surface, so a non-node host could not ask the adjudicator anything.
//
// These tests drive the real HTTP server (bind a socket, fetch it) and assert the
// JSON decision is byte-for-byte the decision govern() returns for the same input,
// including a refused (fail-closed) case.

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { GovernHttpServer, adjudicate } from "../src/govern-http.js";
import { govern } from "../src/governor.js";
import { classify } from "../src/classifier.js";
import { createSession } from "../src/session.js";
import { DEFAULT_POLICY, type GovernedDomain } from "../src/config.js";
import { loadManifestText } from "kcp-agent";

const FJORDWIRE = join(import.meta.dirname ?? ".", "fixtures", "fjordwire", "knowledge.yaml");

/** JSON round-trip — compare exactly what a client over the wire would see. */
const wire = (v: unknown) => JSON.parse(JSON.stringify(v));

/** Reproduce the in-process decision the endpoint must match. */
async function directDecision(
  manifest: { text: string; source?: string },
  domain: GovernedDomain,
  tool: string,
  args: Record<string, unknown>,
) {
  const classification = classify(tool, args, [domain]);
  return govern(classification, tool, args, createSession(), DEFAULT_POLICY, undefined, manifest);
}

describe("adjudicate() — the HTTP govern handler", () => {
  it("returns the same decision govern() would for an approved (auto-plan) call", async () => {
    const { text, source } = await loadManifestText(FJORDWIRE);
    // The label the endpoint gives the in-memory domain; must match the direct call.
    const label = source ?? "in-memory manifest";
    const domain: GovernedDomain = { manifest: label, paths: ["index.md"] };

    const expected = await directDecision({ text, source }, domain, "Read", { file_path: "index.md" });
    expect(expected.approved).toBe(true);
    expect(expected.mode).toBe("auto-plan");

    const result = await adjudicate({
      manifest: { text, source },
      domain: { paths: ["index.md"] },
      request: { tool: "Read", args: { file_path: "index.md" } },
    });

    expect(result.status).toBe(200);
    expect(wire(result.decision)).toEqual(wire(expected));
  });

  it("refuses fail-closed for a governed path no unit covers — same block as govern()", async () => {
    const { text, source } = await loadManifestText(FJORDWIRE);
    const label = source ?? "in-memory manifest";
    const domain: GovernedDomain = { manifest: label, paths: ["stories/"] };

    const expected = await directDecision({ text, source }, domain, "Read", {
      file_path: "stories/not-a-real-story.md",
    });
    expect(expected.approved).toBe(false);
    expect(expected.mode).toBe("auto-plan"); // planner ran, nothing covered the path → blocked

    const result = await adjudicate({
      manifest: { text, source },
      domain: { paths: ["stories/"] },
      request: { tool: "Read", args: { file_path: "stories/not-a-real-story.md" } },
    });

    expect(result.decision.approved).toBe(false);
    expect(wire(result.decision)).toEqual(wire(expected));
  });

  it("fails closed on a malformed body — never approves", async () => {
    const missingManifest = await adjudicate({ request: { tool: "Read", args: {} } });
    expect(missingManifest.status).toBe(400);
    expect(missingManifest.decision.approved).toBe(false);
    expect(missingManifest.decision.mode).toBe("blocked");

    const missingRequest = await adjudicate({ manifest: { text: "units: []" } });
    expect(missingRequest.status).toBe(400);
    expect(missingRequest.decision.approved).toBe(false);

    const notAnObject = await adjudicate("nope");
    expect(notAnObject.status).toBe(400);
    expect(notAnObject.decision.approved).toBe(false);
  });
});

describe("GovernHttpServer — over the wire", () => {
  let server: GovernHttpServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function start(): Promise<string> {
    server = new GovernHttpServer({ port: 0, host: "127.0.0.1" });
    await server.start();
    return server.getAddress();
  }

  it("POST /govern returns the govern() decision as JSON with permissive CORS", async () => {
    const { text, source } = await loadManifestText(FJORDWIRE);
    const label = source ?? "in-memory manifest";
    const domain: GovernedDomain = { manifest: label, paths: ["index.md"] };
    const expected = await directDecision({ text, source }, domain, "Read", { file_path: "index.md" });

    const base = await start();
    const res = await fetch(`${base}/govern`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: { text, source },
        domain: { paths: ["index.md"] },
        request: { tool: "Read", args: { file_path: "index.md" } },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const decision = await res.json();
    expect(decision.approved).toBe(true);
    expect(wire(decision)).toEqual(wire(expected));
  });

  it("answers CORS preflight (OPTIONS) for browser hosts", async () => {
    const base = await start();
    const res = await fetch(`${base}/govern`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toMatch(/POST/);
    await res.text();
  });

  it("a malformed POST body is refused fail-closed with HTTP 400", async () => {
    const base = await start();
    const res = await fetch(`${base}/govern`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    const decision = await res.json();
    expect(decision.approved).toBe(false);
    expect(decision.mode).toBe("blocked");
  });
});

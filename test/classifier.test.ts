import { describe, it, expect } from "vitest";
import {
  classify,
  extractTargets,
  normalizePath,
  matchesPrefix,
} from "../src/classifier.js";
import type { GovernedDomain } from "../src/config.js";

const domain: GovernedDomain = {
  manifest: "./knowledge.yaml",
  paths: ["docs/", "src/"],
  urls: ["https://docs.example.com/"],
};

const urlDomain: GovernedDomain = {
  manifest: "https://remote.example.com/knowledge.yaml",
  urls: ["https://api.example.com/"],
};

const toolDomain: GovernedDomain = {
  manifest: "./special.yaml",
  tools: ["custom_knowledge_tool"],
};

const allDomains = [domain, urlDomain, toolDomain];

describe("classify", () => {
  it("classifies KCP tools as always governed", () => {
    const r = classify("kcp_plan", { task: "test", manifest: "." }, allDomains);
    expect(r.governed).toBe(true);
    expect(r.reason).toMatch(/KCP tool/);
  });

  it("classifies kcp_load as governed", () => {
    const r = classify("kcp_load", { task: "test", manifest: "." }, allDomains);
    expect(r.governed).toBe(true);
  });

  it("classifies Read targeting governed path", () => {
    const r = classify("Read", { file_path: "docs/api.md" }, allDomains);
    expect(r.governed).toBe(true);
    expect(r.domain).toBe(domain);
    expect(r.target).toBe("docs/api.md");
  });

  it("classifies Read targeting governed path with leading ./", () => {
    const r = classify("Read", { file_path: "./src/main.ts" }, allDomains);
    expect(r.governed).toBe(true);
    expect(r.domain).toBe(domain);
  });

  it("classifies Read targeting ungoverned path as pass-through", () => {
    const r = classify("Read", { file_path: "vendor/lib.ts" }, allDomains);
    expect(r.governed).toBe(false);
  });

  it("classifies Glob targeting governed path", () => {
    const r = classify("Glob", { pattern: "src/**/*.ts" }, allDomains);
    expect(r.governed).toBe(true);
    expect(r.domain).toBe(domain);
  });

  it("classifies Glob with path argument", () => {
    const r = classify("Glob", { path: "docs/", pattern: "*.md" }, allDomains);
    expect(r.governed).toBe(true);
    expect(r.domain).toBe(domain);
  });

  it("classifies Grep targeting governed path", () => {
    const r = classify("Grep", { pattern: "TODO", path: "src/" }, allDomains);
    expect(r.governed).toBe(true);
    expect(r.domain).toBe(domain);
  });

  it("classifies WebFetch targeting governed URL", () => {
    const r = classify("WebFetch", { url: "https://docs.example.com/api/v1" }, allDomains);
    expect(r.governed).toBe(true);
    expect(r.domain).toBe(domain);
  });

  it("classifies WebFetch targeting ungoverned URL as pass-through", () => {
    const r = classify("WebFetch", { url: "https://other.example.com/page" }, allDomains);
    expect(r.governed).toBe(false);
  });

  it("classifies explicitly listed tool names", () => {
    const r = classify("custom_knowledge_tool", { query: "test" }, allDomains);
    expect(r.governed).toBe(true);
    expect(r.domain).toBe(toolDomain);
  });

  it("classifies Bash with cat command targeting governed path", () => {
    const r = classify("Bash", { command: "cat docs/readme.md" }, allDomains);
    expect(r.governed).toBe(true);
  });

  it("classifies Bash with non-file command as pass-through", () => {
    const r = classify("Bash", { command: "npm test" }, allDomains);
    expect(r.governed).toBe(false);
  });

  it("classifies unknown tools as pass-through", () => {
    const r = classify("SomeOtherTool", { arg: "value" }, allDomains);
    expect(r.governed).toBe(false);
  });

  it("handles empty domains list", () => {
    const r = classify("Read", { file_path: "docs/api.md" }, []);
    expect(r.governed).toBe(false);
  });

  it("classifies absolute path against relative prefix", () => {
    const r = classify("Read", { file_path: "/project/docs/api.md" }, allDomains);
    // Absolute path doesn't match relative prefix
    expect(r.governed).toBe(false);
  });

  it("classifies Edit tool same as Read", () => {
    const r = classify("Edit", { file_path: "src/main.ts" }, allDomains);
    expect(r.governed).toBe(true);
    expect(r.domain).toBe(domain);
  });
});

describe("extractTargets", () => {
  it("extracts path from Read", () => {
    const t = extractTargets("Read", { file_path: "docs/api.md" });
    expect(t.paths).toEqual(["docs/api.md"]);
    expect(t.urls).toEqual([]);
  });

  it("extracts URL from WebFetch", () => {
    const t = extractTargets("WebFetch", { url: "https://example.com/" });
    expect(t.paths).toEqual([]);
    expect(t.urls).toEqual(["https://example.com/"]);
  });

  it("returns empty for unknown tools", () => {
    const t = extractTargets("Unknown", { arg: "value" });
    expect(t.paths).toEqual([]);
    expect(t.urls).toEqual([]);
  });
});

describe("normalizePath", () => {
  it("strips leading ./", () => {
    expect(normalizePath("./src/main.ts")).toBe("src/main.ts");
  });

  it("collapses double slashes", () => {
    expect(normalizePath("src//main.ts")).toBe("src/main.ts");
  });

  it("preserves leading /", () => {
    expect(normalizePath("/absolute/path")).toBe("/absolute/path");
  });
});

describe("matchesPrefix", () => {
  it("matches exact path", () => {
    expect(matchesPrefix("docs/", "docs/")).toBe(true);
  });

  it("matches path under prefix", () => {
    expect(matchesPrefix("docs/api.md", "docs")).toBe(true);
  });

  it("matches path under prefix with trailing slash", () => {
    expect(matchesPrefix("docs/api.md", "docs/")).toBe(true);
  });

  it("does not match partial directory names", () => {
    expect(matchesPrefix("documentation/api.md", "docs")).toBe(false);
  });

  it("does not match unrelated paths", () => {
    expect(matchesPrefix("vendor/lib.ts", "docs")).toBe(false);
  });
});

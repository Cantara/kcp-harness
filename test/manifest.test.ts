// The repo dogfoods KCP: knowledge.yaml at the root describes this repository
// and harness.yaml governs it through the harness's own proxy. These tests keep
// both honest — the manifest is parseable, points at real files, and is useful
// to the planner it ships; harness.yaml's self-governance domain points at it.

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, planTree, plans, validateManifest, type Manifest } from "kcp-agent";
import { loadConfig } from "../src/config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the repo's own knowledge.yaml", () => {
  let manifest: Manifest;
  beforeAll(async () => {
    manifest = await loadManifest(repoRoot);
  });

  it("parses into the compact model", () => {
    expect(manifest.project).toBe("kcp-harness");
    expect(manifest.units.length).toBeGreaterThan(0);
  });

  it("declares only unit paths that exist on disk", () => {
    for (const unit of manifest.units) {
      expect(existsSync(join(repoRoot, unit.path)), `unit '${unit.id}' → ${unit.path}`).toBe(true);
    }
  });

  it("passes manifest validation with no issues", async () => {
    const issues = await validateManifest(manifest);
    expect(issues, JSON.stringify(issues)).toEqual([]);
  });

  it("is useful to the planner it ships", async () => {
    const tree = await planTree(repoRoot, "how does the harness govern a tool call?", {});
    expect(tree.error).toBeUndefined();
    const plan = Array.from(plans(tree))[0];
    expect(plan).toBeDefined();
    expect(plan!.selected.length).toBeGreaterThan(0);
  });
});

describe("the repo's own harness.yaml", () => {
  it("self-governs through the root knowledge.yaml", () => {
    const config = loadConfig(join(repoRoot, "harness.yaml"));
    const selfDomain = config.governance.domains.find((d) => d.manifest === "./knowledge.yaml");
    expect(selfDomain, "a domain must point at the repo's own ./knowledge.yaml").toBeDefined();
    expect(selfDomain!.paths).toEqual(expect.arrayContaining(["src/", "docs/"]));
    expect(config.governance.policy.fail_closed).toBe(true);
  });
});

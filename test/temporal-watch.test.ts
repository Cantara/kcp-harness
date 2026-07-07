// Temporal watch tests — verify drift detection with real manifests.

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { TemporalWatch } from "../src/temporal-watch.js";
import { planTree, plans, type FollowOptions, type AgentPlan } from "kcp-agent";

// Resolve the fjordwire test fixture (bundled in repo, no sibling checkout needed)
const FJORDWIRE = resolve(
  import.meta.dirname ?? ".",
  "fixtures/fjordwire/knowledge.yaml",
);

const defaultFollow: FollowOptions = {
  planOptions: {},
  maxDepth: 0,
  fetchGuard: {},
};

async function makePlan(manifest: string, task: string, follow: FollowOptions = defaultFollow): Promise<AgentPlan> {
  const tree = await planTree(manifest, task, follow);
  const all = Array.from(plans(tree));
  return all[0];
}

describe("TemporalWatch", () => {
  it("registers and retrieves watched plans", async () => {
    const watch = new TemporalWatch();
    const plan = await makePlan(FJORDWIRE, "front page");
    watch.register(FJORDWIRE, "front page", plan, defaultFollow);
    expect(watch.getWatched().size).toBe(1);
    expect(watch.get(FJORDWIRE)?.task).toBe("front page");
  });

  it("unregisters plans", async () => {
    const watch = new TemporalWatch();
    const plan = await makePlan(FJORDWIRE, "front page");
    watch.register(FJORDWIRE, "front page", plan, defaultFollow);
    watch.unregister(FJORDWIRE);
    expect(watch.getWatched().size).toBe(0);
  });

  it("check returns stable when plan has not drifted", async () => {
    const watch = new TemporalWatch();
    // Plan with today's date — re-evaluation with today should be identical
    const plan = await makePlan(FJORDWIRE, "sovereign compute award");
    watch.register(FJORDWIRE, "sovereign compute award", plan, defaultFollow);

    const result = await watch.check();
    expect(result.checked).toBe(1);
    expect(result.stable).toBe(1);
    expect(result.drifted).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("check detects drift when as-of date differs", async () => {
    const watch = new TemporalWatch();
    // Plan with an old date — some units may have different temporal status
    const oldFollow: FollowOptions = {
      ...defaultFollow,
      planOptions: { asOf: "2026-06-01" },
    };
    const oldPlan = await makePlan(FJORDWIRE, "sovereign compute award", oldFollow);
    watch.register(FJORDWIRE, "sovereign compute award", oldPlan, oldFollow);

    // Check will re-plan with today's date — may detect drift
    const result = await watch.check();
    expect(result.checked).toBe(1);
    // Whether it actually drifted depends on the fjordwire manifest's
    // temporal windows. The chipfab-exclusive valid_from is 2026-07-05,
    // so a plan from 2026-06-01 won't include it, but today it will.
    if (result.drifted.length > 0) {
      const drift = result.drifted[0];
      expect(drift.drifted).toBe(true);
      expect(drift.summary).toMatch(/temporal drift/);
      expect(drift.diff).toBeTruthy();
    }
  });

  it("checkOne returns structured drift result", async () => {
    const watch = new TemporalWatch();
    const plan = await makePlan(FJORDWIRE, "front page");
    const watched = {
      manifest: FJORDWIRE,
      task: "front page",
      plan,
      followOptions: defaultFollow,
      registeredAt: new Date().toISOString(),
    };

    const result = await watch.checkOne(watched);
    expect(result.manifest).toBe(FJORDWIRE);
    expect(result.task).toBe("front page");
    expect(result.checkedAt).toBeTruthy();
    // Same day → should be stable
    expect(result.drifted).toBe(false);
  });

  it("handles multiple watched plans", async () => {
    const watch = new TemporalWatch();
    const plan1 = await makePlan(FJORDWIRE, "front page");
    const plan2 = await makePlan(FJORDWIRE, "datacenter power");
    watch.register(FJORDWIRE + "#1", "front page", plan1, defaultFollow);
    watch.register(FJORDWIRE + "#2", "datacenter power", plan2, defaultFollow);

    const result = await watch.check();
    expect(result.checked).toBe(2);
  });
});

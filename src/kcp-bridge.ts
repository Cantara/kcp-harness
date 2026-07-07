// KCP bridge — call kcp-agent's planner functions from the harness.
//
// Instead of importing kcp-agent's internal MCP handler (which isn't part
// of the public API), we use the exported planner functions directly.
// This gives us the same results with type safety and a stable API surface.

import {
  planTree,
  plans,
  loadPlannedUnits,
  loadManifest,
  trace as traceDecision,
  validateLocation,
  dedupeLoaded,
  type FollowOptions,
  type PlanOptions,
  type KnownUnits,
} from "kcp-agent";

/** Accept a JSON array or a comma-separated string — MCP callers send both. */
function toList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
}

/** Map MCP-style arguments to kcp-agent's FollowOptions. */
function toFollowOptions(args: Record<string, unknown>): FollowOptions {
  const methods = toList(args["methods"]);
  const credentials = toList(args["credentials"]);
  const planOptions: PlanOptions = {
    env: args["env"] === undefined ? undefined : String(args["env"]),
    asOf: args["as_of"] === undefined ? undefined : String(args["as_of"]),
    maxUnits: args["max_units"] === undefined ? undefined : Number(args["max_units"]),
    strict: args["strict"] === true,
    budget:
      args["budget"] === undefined
        ? undefined
        : { amount: Number(args["budget"]), currency: args["currency"] === undefined ? undefined : String(args["currency"]) },
    contextBudget: args["context_budget"] === undefined ? undefined : Number(args["context_budget"]),
    capabilities: {
      ...(args["role"] === undefined ? {} : { role: String(args["role"]) }),
      ...(methods ? { paymentMethods: methods } : {}),
      ...(credentials ? { credentials } : {}),
      ...(args["attest"] === undefined ? {} : { attestationProvider: String(args["attest"]) }),
    },
  };
  return {
    planOptions,
    maxDepth: args["follow"] === true ? (args["max_depth"] === undefined ? 1 : Number(args["max_depth"])) : 0,
    maxNodes: args["max_nodes"] === undefined ? undefined : Number(args["max_nodes"]),
    fetchGuard: { allowPrivate: args["allow_private_hosts"] === true },
  };
}

/** Call a KCP tool and return the result as a JSON string. */
export async function callKcpTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "kcp_plan": {
      const tree = await planTree(String(args["manifest"] ?? ""), String(args["task"] ?? ""), toFollowOptions(args));
      if (tree.error) throw new Error(`${tree.location}: ${tree.error}`);
      return JSON.stringify(tree, null, 2);
    }
    case "kcp_load": {
      const follow = toFollowOptions(args);
      const tree = await planTree(String(args["manifest"] ?? ""), String(args["task"] ?? ""), follow);
      if (tree.error) throw new Error(`${tree.location}: ${tree.error}`);
      const loaded = [];
      const unavailable: Array<{ id: string; reason: string }> = [];
      for (const p of plans(tree)) {
        const r = await loadPlannedUnits(p, follow.fetchGuard);
        loaded.push(...r.loaded);
        unavailable.push(...r.unavailable);
      }
      const { units, deduped, bytesSaved } = dedupeLoaded(loaded, args["known"] as KnownUnits | undefined);
      return JSON.stringify({ plan: tree, units, unavailable, deduped, bytesSaved }, null, 2);
    }
    case "kcp_trace": {
      const follow = toFollowOptions(args);
      const manifest = await loadManifest(String(args["manifest"] ?? ""), follow.fetchGuard);
      const t = traceDecision(manifest, String(args["task"] ?? ""), follow.planOptions);
      return JSON.stringify(t, null, 2);
    }
    case "kcp_validate": {
      const guard = { allowPrivate: args["allow_private_hosts"] === true };
      const report = await validateLocation(String(args["manifest"] ?? ""), guard);
      return JSON.stringify(report, null, 2);
    }
    case "kcp_replay": {
      // Replay requires importing the replay function — use dynamic import
      // to keep the bridge lightweight for non-replay use cases.
      throw new Error("kcp_replay not yet bridged — call kcp-agent directly");
    }
    default:
      throw new Error(`unknown KCP tool: ${name}`);
  }
}

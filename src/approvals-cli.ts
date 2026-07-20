// Approvals CLI — the built-in review channel for the FileApprovalProvider.
//
// The proxy opens tickets; a human resolves them here (or via any other
// ApprovalProvider channel an org wires up). Resolutions require a named
// reviewer and a policy reference — the CLI refuses anything less, the
// same invariant the provider enforces.
//
//   kcp-harness approvals list [--state pending_review]
//   kcp-harness approvals approve <id> --reviewer "Kari N." --policy-ref POL-7.2 [--note ...]
//   kcp-harness approvals dismiss <id> --reviewer "Kari N." --policy-ref POL-7.2 [--note ...]

import type { HarnessConfig } from "./config.js";
import { providerFromConfig, type ApprovalState, type ApprovalStatus } from "./approval.js";
import { buildApprovalEvent, type AuditWriter } from "./audit.js";

/** Run an approvals subcommand; returns the text to print. Throws on misuse. */
export async function runApprovals(
  argv: string[],
  config: HarnessConfig,
  audit?: AuditWriter,
): Promise<string> {
  const approvalsConfig = config.governance.approvals;
  if (!approvalsConfig) {
    throw new Error("no approvals configured — add governance.approvals to harness.yaml");
  }
  const provider = providerFromConfig(approvalsConfig);
  const sub = argv[0];

  switch (sub) {
    case "list": {
      const state = flag(argv, "--state") as ApprovalState | undefined;
      const statuses = await provider.list(state ? { state } : undefined);
      if (statuses.length === 0) return "no approval tickets\n";
      return statuses.map(formatStatus).join("\n") + "\n";
    }

    case "approve":
    case "dismiss": {
      const id = argv[1];
      if (!id || id.startsWith("--")) throw new Error(`usage: approvals ${sub} <id> --reviewer <name> --policy-ref <ref>`);
      const reviewer = flag(argv, "--reviewer");
      if (!reviewer) throw new Error(`--reviewer is required — resolutions are never anonymous`);
      const policyRef = flag(argv, "--policy-ref");
      if (!policyRef) throw new Error(`--policy-ref is required — cite the policy this resolution satisfies`);
      const note = flag(argv, "--note");

      const status = await provider.resolve({
        id,
        state: sub === "approve" ? "approved" : "dismissed",
        reviewer,
        reviewedAt: new Date().toISOString(),
        policyRef,
        note,
      });

      // The resolution is an audit event on the same log the proxy writes
      audit?.emit(buildApprovalEvent(status.request.sessionId, 0, "approval_resolved", status));

      return formatStatus(status) + "\n";
    }

    default:
      throw new Error(`unknown approvals subcommand: ${sub ?? "(none)"} — expected list, approve, or dismiss`);
  }
}

function formatStatus(s: ApprovalStatus): string {
  const head = `${s.request.id}  ${s.state}  ${s.request.toolName} ${s.request.target}  role=${s.request.requiredRole}`;
  const when = `  requested=${s.request.requestedAt}${s.request.expiresAt ? ` expires=${s.request.expiresAt}` : ""}`;
  const who = s.resolution
    ? `\n  ${s.resolution.state} by ${s.resolution.reviewer} at ${s.resolution.reviewedAt} (${s.resolution.policyRef})${s.resolution.note ? ` — ${s.resolution.note}` : ""}`
    : "";
  return head + when + who;
}

function flag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

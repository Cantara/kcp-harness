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
//
// A resolution may be signed for non-repudiation: pass --private-key <pem> and
// optionally --key-id. When governance.approvals.require_signed_resolutions is
// on, an unsigned or invalid resolution is rejected (fail-closed).

import { readFileSync } from "node:fs";
import type { HarnessConfig } from "./config.js";
import { evaluateGrant, grantMaxMs, providerFromConfig, type ApprovalState, type ApprovalStatus } from "./approval.js";
import { signResolution, type ResolutionSignature } from "./resolution-signature.js";
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
      const maxMs = grantMaxMs(approvalsConfig.grant_max);
      return statuses.map((s) => formatStatus(s, maxMs)).join("\n") + "\n";
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

      const state = sub === "approve" ? "approved" as const : "dismissed" as const;
      const reviewedAt = new Date().toISOString();

      // Optionally sign the resolution over its canonical payload. The payload
      // binds the reviewer's decision to this specific ticket (target + tool),
      // so the signature is fetched against the ticket the CLI is resolving.
      let signature: ResolutionSignature | undefined;
      const privateKeyPath = flag(argv, "--private-key");
      if (privateKeyPath) {
        const existing = await provider.check(id);
        if (!existing) throw new Error(`unknown approval ticket: ${id}`);
        const pem = readFileSync(privateKeyPath, "utf-8");
        signature = await signResolution(
          pem,
          {
            id,
            target: existing.request.target,
            tool: existing.request.toolName,
            state,
            reviewer,
            policyRef,
            timestamp: reviewedAt,
          },
          flag(argv, "--key-id"),
        );
      }

      const status = await provider.resolve({
        id,
        state,
        reviewer,
        reviewedAt,
        policyRef,
        note,
        ...(signature ? { signature } : {}),
      });

      // The resolution is an audit event on the same log the proxy writes, and carries the
      // ticket's correlation so a named human's approval stays attached to the action it
      // authorised. Without it, the record an audit cares about most — a person signed this
      // off — dropped out of the chain at the moment it was created.
      audit?.emit(
        buildApprovalEvent(
          status.request.sessionId,
          0,
          "approval_resolved",
          status,
          status.request.correlationId,
        ),
      );

      return formatStatus(status, grantMaxMs(approvalsConfig.grant_max)) + "\n";
    }

    default:
      throw new Error(`unknown approvals subcommand: ${sub ?? "(none)"} — expected list, approve, or dismiss`);
  }
}

function formatStatus(s: ApprovalStatus, maxMs: number): string {
  const head = `${s.request.id}  ${s.state}  ${s.request.toolName} ${s.request.target}  role=${s.request.requiredRole}`;
  const when = `  requested=${s.request.requestedAt}${s.request.expiresAt ? ` expires=${s.request.expiresAt}` : ""}`;
  const signed = s.resolution?.signature
    ? ` [signed${s.resolution.signature.keyId ? ` ${s.resolution.signature.keyId}` : ""}]`
    : "";
  // An approved ticket whose grant has lapsed keeps its stored state but is flagged, so a
  // reviewer never reads a dead approval as a live one.
  const lapsed =
    s.state === "approved" && !evaluateGrant(s, { target: s.request.target, toolName: s.request.toolName, sessionId: s.request.sessionId, argsDigest: s.request.argsDigest, maxMs }).ok
      ? " [grant expired]"
      : "";
  const grant = s.request.grant ? ` grant=${s.request.grant.mode}${s.request.grant.durationMs ? `:${s.request.grant.durationMs / 60_000}m` : ""}` : "";
  const used = s.use ? `\n  used at ${s.use.usedAt}${s.use.correlationId ? ` by correlation ${s.use.correlationId}` : ""} (session ${s.use.sessionId})` : "";
  const who = s.resolution
    ? `\n  ${s.resolution.state} by ${s.resolution.reviewer} at ${s.resolution.reviewedAt} (${s.resolution.policyRef})${signed}${s.resolution.note ? ` — ${s.resolution.note}` : ""}`
    : "";
  return head + lapsed + when + ` session=${s.request.sessionId}` + grant + who + used;
}

function flag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

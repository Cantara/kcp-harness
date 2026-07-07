// Compliance evidence export — SOC 2 Type II and ISO 27001 Annex A.
//
// Reads the audit JSONL log and produces structured evidence bundles
// suitable for compliance auditors. The mapping is deterministic: audit
// events map to specific control IDs based on their type and outcome.
//
// Output: a directory of JSON evidence files + Markdown summary reports.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditReader, type AuditSummary, type SessionIndex } from "./audit-reader.js";
import type { AuditEvent } from "./audit.js";

/** Export configuration. */
export interface ExportOptions {
  /** Path to the audit JSONL log. */
  auditPath: string;
  /** Output directory for evidence bundles. */
  outputDir: string;
  /** Which framework(s) to export. */
  format: "soc2" | "iso27001" | "both";
  /** Optional date range filter. */
  dateRange?: { from: string; to: string };
  /** Organization name for the report header. */
  organization?: string;
}

/** Result of an export operation. */
export interface ExportResult {
  /** Output directory. */
  outputDir: string;
  /** Files created. */
  files: string[];
  /** Summary statistics. */
  summary: AuditSummary;
}

/** Evidence entry for a compliance control. */
interface ControlEvidence {
  controlId: string;
  controlName: string;
  description: string;
  evidenceCount: number;
  events: Array<{
    timestamp: string;
    sessionId: string;
    type: string;
    outcome: string;
    detail: string;
  }>;
}

/** Export compliance evidence from the audit log. */
export async function exportEvidence(options: ExportOptions): Promise<ExportResult> {
  const reader = new AuditReader(options.auditPath);
  const filter = options.dateRange
    ? { from: options.dateRange.from, to: options.dateRange.to }
    : undefined;

  const events = await reader.readAll(filter);
  const summary = await reader.summarize(filter);
  const sessionIndex = await reader.sessionIndex();
  const files: string[] = [];

  // Create output directories
  mkdirSync(options.outputDir, { recursive: true });

  // Write manifest
  const manifest = {
    generator: "kcp-harness",
    generatedAt: new Date().toISOString(),
    organization: options.organization,
    format: options.format,
    dateRange: options.dateRange ?? summary.dateRange,
    statistics: summary,
  };
  writeJSON(options.outputDir, "manifest.json", manifest);
  files.push("manifest.json");

  // Write raw data
  mkdirSync(join(options.outputDir, "raw"), { recursive: true });
  writeJSON(options.outputDir, "raw/sessions.json", sessionIndex);
  writeJSON(options.outputDir, "raw/statistics.json", summary);
  files.push("raw/sessions.json", "raw/statistics.json");

  // Generate framework-specific evidence
  if (options.format === "soc2" || options.format === "both") {
    const soc2Files = exportSOC2(options.outputDir, events, summary, options.organization);
    files.push(...soc2Files);
  }

  if (options.format === "iso27001" || options.format === "both") {
    const isoFiles = exportISO27001(options.outputDir, events, summary, options.organization);
    files.push(...isoFiles);
  }

  return { outputDir: options.outputDir, files, summary };
}

// -- SOC 2 Type II (Trust Services Criteria) ----------------------------------

function exportSOC2(
  outputDir: string,
  events: AuditEvent[],
  summary: AuditSummary,
  org?: string,
): string[] {
  const dir = join(outputDir, "soc2");
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];

  // CC6.1 — Logical and physical access controls
  const cc61 = buildControlEvidence(
    "CC6.1",
    "Logical and Physical Access Controls",
    "The entity implements logical access security software, infrastructure, and architectures over protected information assets to protect them from security events.",
    events,
    (e) => e.type === "tool_call" && e.classification?.governed === true,
    (e) => `${e.outcome}: ${e.governance?.reason ?? e.toolCall?.name ?? "unknown"}`,
  );
  writeJSON(dir, "CC6.1-logical-access.json", cc61);
  files.push("soc2/CC6.1-logical-access.json");

  // CC6.3 — Authorized access
  const cc63 = buildControlEvidence(
    "CC6.3",
    "Authorized Access",
    "The entity authorizes, modifies, or removes access to data, software, functions, and other protected information assets based on roles, responsibilities, or the system design and changes.",
    events,
    (e) => e.type === "tool_call" && e.governance?.mode === "plan-first",
    (e) => `pre-authorized via plan "${e.governance?.approvedPlan?.task ?? "unknown"}"`,
  );
  writeJSON(dir, "CC6.3-authorized-access.json", cc63);
  files.push("soc2/CC6.3-authorized-access.json");

  // CC6.6 — System boundaries
  const cc66 = buildControlEvidence(
    "CC6.6",
    "System Boundaries",
    "The entity implements logical access security measures to protect against threats from sources outside its system boundaries.",
    events,
    (e) => e.type === "tool_call",
    (e) => e.classification?.governed
      ? `governed: ${e.classification.reason}`
      : `pass-through: ${e.classification?.reason ?? "unclassified"}`,
  );
  writeJSON(dir, "CC6.6-system-boundaries.json", cc66);
  files.push("soc2/CC6.6-system-boundaries.json");

  // CC7.2 — Monitoring
  const cc72 = buildControlEvidence(
    "CC7.2",
    "Monitoring Activities",
    "The entity monitors system components and the operation of those components for anomalies that are indicative of malicious acts, natural disasters, and errors affecting the entity's ability to meet its objectives.",
    events,
    (_e) => true,
    (e) => `[${e.type}] ${e.outcome}: ${shortDetail(e)}`,
  );
  writeJSON(dir, "CC7.2-monitoring.json", cc72);
  files.push("soc2/CC7.2-monitoring.json");

  // CC8.1 — Change management
  const cc81 = buildControlEvidence(
    "CC8.1",
    "Change Management",
    "The entity authorizes, designs, develops or acquires, configures, documents, tests, approves, and implements changes to infrastructure, data, software, and procedures to meet its objectives.",
    events,
    (e) => e.type === "temporal_drift" || e.type === "plan_invalidated",
    (e) => e.drift
      ? `drift detected in ${e.drift.manifest}: ${e.drift.summary}`
      : `${e.type}: ${e.outcome}`,
  );
  writeJSON(dir, "CC8.1-change-management.json", cc81);
  files.push("soc2/CC8.1-change-management.json");

  // Summary report
  const report = generateSOC2Report(summary, cc61, cc63, cc66, cc72, cc81, org);
  writeFile(dir, "summary.md", report);
  files.push("soc2/summary.md");

  return files;
}

// -- ISO 27001 Annex A --------------------------------------------------------

function exportISO27001(
  outputDir: string,
  events: AuditEvent[],
  summary: AuditSummary,
  org?: string,
): string[] {
  const dir = join(outputDir, "iso27001");
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];

  // A.8.3 — Information access restriction
  const a83 = buildControlEvidence(
    "A.8.3",
    "Information Access Restriction",
    "Access to information and other associated assets shall be restricted in accordance with the established topic-specific policy on access control.",
    events,
    (e) => e.type === "tool_call" && e.classification?.governed === true,
    (e) => `${e.outcome}: ${e.governance?.reason ?? e.toolCall?.name ?? "unknown"}`,
  );
  writeJSON(dir, "A.8.3-access-restriction.json", a83);
  files.push("iso27001/A.8.3-access-restriction.json");

  // A.8.4 — Access to source code
  const a84 = buildControlEvidence(
    "A.8.4",
    "Access to Source Code",
    "Read and write access to source code, development tools and software libraries shall be appropriately managed.",
    events,
    (e) => e.type === "tool_call" && e.classification?.governed === true
      && (e.toolCall?.name === "Read" || e.toolCall?.name === "Glob" || e.toolCall?.name === "Grep"),
    (e) => `${e.toolCall?.name} ${e.classification?.target ?? ""}: ${e.outcome}`,
  );
  writeJSON(dir, "A.8.4-source-code-access.json", a84);
  files.push("iso27001/A.8.4-source-code-access.json");

  // A.8.15 — Logging
  const a815 = buildControlEvidence(
    "A.8.15",
    "Logging",
    "Logs that record activities, exceptions, faults and other relevant events shall be produced, stored, protected and analysed.",
    events,
    (e) => e.type === "session_start" || e.type === "session_end",
    (e) => `session ${e.sessionId}: ${e.type}`,
  );
  writeJSON(dir, "A.8.15-logging.json", a815);
  files.push("iso27001/A.8.15-logging.json");

  // A.8.16 — Monitoring activities
  const a816 = buildControlEvidence(
    "A.8.16",
    "Monitoring Activities",
    "Networks, systems and applications shall be monitored for anomalous behaviour and appropriate actions taken to evaluate potential information security incidents.",
    events,
    (e) => e.type === "temporal_drift" || e.type === "budget_exceeded" || e.outcome === "blocked",
    (e) => `[${e.type}] ${e.outcome}: ${shortDetail(e)}`,
  );
  writeJSON(dir, "A.8.16-monitoring.json", a816);
  files.push("iso27001/A.8.16-monitoring.json");

  // A.5.23 — Information security for use of cloud services
  const a523 = buildControlEvidence(
    "A.5.23",
    "Information Security for Use of Cloud Services",
    "Processes for acquisition, use, management and exit from cloud services shall be established in accordance with the organization's information security requirements.",
    events,
    (e) => e.type === "tool_call" && e.signature !== undefined,
    (e) => `signature ${e.signature?.status ?? "unknown"}: ${e.signature?.detail ?? e.toolCall?.name ?? ""}`,
  );
  writeJSON(dir, "A.5.23-cloud-services.json", a523);
  files.push("iso27001/A.5.23-cloud-services.json");

  // Summary report
  const report = generateISO27001Report(summary, a83, a84, a815, a816, a523, org);
  writeFile(dir, "summary.md", report);
  files.push("iso27001/summary.md");

  return files;
}

// -- Helpers ------------------------------------------------------------------

function buildControlEvidence(
  controlId: string,
  controlName: string,
  description: string,
  events: AuditEvent[],
  predicate: (e: AuditEvent) => boolean,
  detailFn: (e: AuditEvent) => string,
): ControlEvidence {
  const matching = events.filter(predicate);
  return {
    controlId,
    controlName,
    description,
    evidenceCount: matching.length,
    events: matching.map((e) => ({
      timestamp: e.timestamp,
      sessionId: e.sessionId,
      type: e.type,
      outcome: e.outcome,
      detail: detailFn(e),
    })),
  };
}

function shortDetail(e: AuditEvent): string {
  if (e.drift) return `drift in ${e.drift.manifest}`;
  if (e.budget) return `budget ${e.budget.totals?.USDC ?? 0}/${e.budget.ceiling?.amount ?? "∞"}`;
  if (e.governance) return e.governance.reason;
  if (e.toolCall) return `${e.toolCall.name}`;
  return e.type;
}

function generateSOC2Report(
  summary: AuditSummary,
  ...controls: [...ControlEvidence[], string | undefined]
): string {
  const org = controls.pop() as string | undefined;
  const ctrls = controls as ControlEvidence[];
  const lines: string[] = [
    `# SOC 2 Type II — Evidence Summary`,
    org ? `\n**Organization**: ${org}` : "",
    `\n**Generated**: ${new Date().toISOString()}`,
    `**Period**: ${summary.dateRange.first || "N/A"} — ${summary.dateRange.last || "N/A"}`,
    ``,
    `## Overview`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Sessions | ${summary.sessions} |`,
    `| Total events | ${summary.events} |`,
    `| Governed access attempts | ${summary.governed} |`,
    `| Blocked | ${summary.blocked} |`,
    `| Budget exceeded | ${summary.budgetExceeded} |`,
    `| Temporal drifts | ${summary.drifts} |`,
    `| Signature-blocked | ${summary.signatureBlocked} |`,
    ``,
    `## Controls`,
    ``,
    `| Control | Name | Evidence Count |`,
    `|---------|------|---------------|`,
    ...ctrls.map((c) => `| ${c.controlId} | ${c.controlName} | ${c.evidenceCount} |`),
    ``,
    ...ctrls.map((c) => [
      `### ${c.controlId} — ${c.controlName}`,
      ``,
      `> ${c.description}`,
      ``,
      `Evidence items: **${c.evidenceCount}**`,
      ``,
    ].join("\n")),
  ];
  return lines.filter(Boolean).join("\n") + "\n";
}

function generateISO27001Report(
  summary: AuditSummary,
  ...controls: [...ControlEvidence[], string | undefined]
): string {
  const org = controls.pop() as string | undefined;
  const ctrls = controls as ControlEvidence[];
  const lines: string[] = [
    `# ISO 27001 Annex A — Evidence Summary`,
    org ? `\n**Organization**: ${org}` : "",
    `\n**Generated**: ${new Date().toISOString()}`,
    `**Period**: ${summary.dateRange.first || "N/A"} — ${summary.dateRange.last || "N/A"}`,
    ``,
    `## Overview`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Sessions | ${summary.sessions} |`,
    `| Total events | ${summary.events} |`,
    `| Governed access attempts | ${summary.governed} |`,
    `| Blocked | ${summary.blocked} |`,
    `| Budget exceeded | ${summary.budgetExceeded} |`,
    `| Temporal drifts | ${summary.drifts} |`,
    `| Signature-blocked | ${summary.signatureBlocked} |`,
    ``,
    `## Controls`,
    ``,
    `| Control | Name | Evidence Count |`,
    `|---------|------|---------------|`,
    ...ctrls.map((c) => `| ${c.controlId} | ${c.controlName} | ${c.evidenceCount} |`),
    ``,
    ...ctrls.map((c) => [
      `### ${c.controlId} — ${c.controlName}`,
      ``,
      `> ${c.description}`,
      ``,
      `Evidence items: **${c.evidenceCount}**`,
      ``,
    ].join("\n")),
  ];
  return lines.filter(Boolean).join("\n") + "\n";
}

function writeJSON(dir: string, filename: string, data: unknown): void {
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeFile(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, "utf-8");
}

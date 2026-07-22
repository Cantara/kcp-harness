// Compliance evidence export — SOC 2 Type II, ISO 27001 Annex A,
// ISO/IEC 42001 (AI management system), and the EU AI Act.
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
  format: "soc2" | "iso27001" | "iso42001" | "euaiact" | "both";
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

  if (options.format === "iso42001") {
    const iso42001Files = exportISO42001(options.outputDir, events, summary, options.organization);
    files.push(...iso42001Files);
  }

  if (options.format === "euaiact") {
    const euaiactFiles = exportEUAIAct(options.outputDir, events, summary, options.organization);
    files.push(...euaiactFiles);
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

// -- ISO/IEC 42001 (AI Management System — Annex A controls) ------------------

function exportISO42001(
  outputDir: string,
  events: AuditEvent[],
  summary: AuditSummary,
  org?: string,
): string[] {
  const dir = join(outputDir, "iso42001");
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];

  // A.6.2.6 — AI system operation and monitoring
  const a626 = buildControlEvidence(
    "A.6.2.6",
    "AI System Operation and Monitoring",
    "The organization shall define and document the necessary elements to operate and monitor AI systems, including monitoring for anomalous behaviour throughout their operation.",
    events,
    (e) => e.type === "temporal_drift" || e.type === "budget_exceeded" || e.outcome === "blocked",
    (e) => `[${e.type}] ${e.outcome}: ${shortDetail(e)}`,
  );
  writeJSON(dir, "A.6.2.6-operation-monitoring.json", a626);
  files.push("iso42001/A.6.2.6-operation-monitoring.json");

  // A.6.2.8 — AI system recording of event logs
  const a628 = buildControlEvidence(
    "A.6.2.8",
    "AI System Recording of Event Logs",
    "The organization shall determine at which phases of the AI system life cycle logging of events is enabled, and shall keep records of the AI system's operation as an append-only event log.",
    events,
    (e) => e.type === "session_start" || e.type === "session_end",
    (e) => `session ${e.sessionId}: ${e.type}`,
  );
  writeJSON(dir, "A.6.2.8-event-logs.json", a628);
  files.push("iso42001/A.6.2.8-event-logs.json");

  // A.9.2 — Processes for responsible use of AI systems. Governed tool calls,
  // governed skill/procedure invocations, and the procedural-conformance
  // adjudication of each post-load action are all responsible-use / operation-
  // monitoring evidence: a skill runs only after passing skill_eligibility, and
  // its subsequent actions are held to its declared action_scope (#39).
  const a92 = buildControlEvidence(
    "A.9.2",
    "Processes for Responsible Use of AI Systems",
    "The organization shall define and implement processes for the responsible use of AI systems, ensuring that governed operations — including invocation of governed skills and procedures, and the ongoing monitoring of each invoked procedure's actions against its declared scope — are subject to access control and policy.",
    events,
    (e) =>
      (e.type === "tool_call" && e.classification?.governed === true) ||
      e.type === "skill_loaded" ||
      e.type === "skill_skipped" ||
      e.type === "conformance_verdict",
    (e) => e.conformance ? conformanceDetail(e) : e.skill ? skillDetail(e) : `${e.outcome}: ${e.governance?.reason ?? e.toolCall?.name ?? "unknown"}`,
  );
  writeJSON(dir, "A.9.2-responsible-use.json", a92);
  files.push("iso42001/A.9.2-responsible-use.json");

  // A.6.2.2 — AI system impact assessment (skill/procedure invocation control).
  // Every governed skill invocation is adjudicated against its declared action
  // scope before it may act — the skill_eligibility gate is fail-closed.
  const a622 = buildControlEvidence(
    "A.6.2.2",
    "AI System Impact — Skill Invocation Control",
    "The organization shall control the invocation of governed skills and procedures, admitting only those a deterministic eligibility gate has authorized and recording each verdict with its written reason.",
    events,
    (e) => e.type === "skill_loaded" || e.type === "skill_skipped",
    (e) => skillDetail(e),
  );
  writeJSON(dir, "A.6.2.2-skill-invocation.json", a622);
  files.push("iso42001/A.6.2.2-skill-invocation.json");

  // A.9.4 — Human oversight of AI systems
  const a94 = buildControlEvidence(
    "A.9.4",
    "Human Oversight of AI Systems",
    "The organization shall ensure that AI systems can be overseen by humans, including the ability to require human approval before high-impact operations proceed.",
    events,
    (e) => e.type === "approval_requested" || e.type === "approval_resolved",
    (e) => `${e.type} [${e.approval?.state ?? e.outcome}]: ${e.approval?.reviewer ?? e.approval?.requiredRole ?? e.approval?.toolName ?? "pending"}`,
  );
  writeJSON(dir, "A.9.4-human-oversight.json", a94);
  files.push("iso42001/A.9.4-human-oversight.json");

  // A.6.2.4 — AI system verification and validation
  const a624 = buildControlEvidence(
    "A.6.2.4",
    "AI System Verification and Validation",
    "The organization shall define and document verification and validation measures for AI systems, including adjudication of outputs against confidence thresholds.",
    events,
    (e) => e.type === "confidence_verdict",
    (e) => `${e.confidence?.task ?? "?"} — ${e.confidence?.passed ? "passed" : "failed"} (${e.confidence?.score ?? 0}/${e.confidence?.threshold ?? 0})`,
  );
  writeJSON(dir, "A.6.2.4-verification-validation.json", a624);
  files.push("iso42001/A.6.2.4-verification-validation.json");

  // Summary report
  const report = generateReport(
    "ISO/IEC 42001 — AI Management System Evidence Summary",
    summary,
    [a626, a628, a92, a622, a94, a624],
    org,
  );
  writeFile(dir, "summary.md", report);
  files.push("iso42001/summary.md");

  return files;
}

// -- EU AI Act (Art. 12 record-keeping, Art. 14 human oversight) --------------

function exportEUAIAct(
  outputDir: string,
  events: AuditEvent[],
  summary: AuditSummary,
  org?: string,
): string[] {
  const dir = join(outputDir, "eu-ai-act");
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];

  // Article 12(1) — Automatic recording of events (append-only log)
  const art12log = buildControlEvidence(
    "Art.12(1)",
    "Record-Keeping — Automatic Logging",
    "High-risk AI systems shall technically allow for the automatic recording of events (logs) over the lifetime of the system. Every governance decision is captured as an append-only audit record.",
    events,
    (_e) => true,
    (e) => `[${e.type}] ${e.outcome}: ${shortDetail(e)}`,
  );
  writeJSON(dir, "Art.12-1-automatic-logging.json", art12log);
  files.push("eu-ai-act/Art.12-1-automatic-logging.json");

  // Article 12(2) — Traceability of system operation over its lifecycle
  const art12trace = buildControlEvidence(
    "Art.12(2)",
    "Record-Keeping — Traceability of Operation",
    "Logging capabilities shall ensure a level of traceability of the AI system's functioning throughout its lifecycle, including session boundaries, any drift that invalidates a plan, and every governed skill/procedure invocation.",
    events,
    (e) => e.type === "session_start" || e.type === "session_end"
      || e.type === "temporal_drift" || e.type === "plan_invalidated"
      || e.type === "skill_loaded" || e.type === "skill_skipped",
    (e) => e.skill
      ? skillDetail(e)
      : e.drift
        ? `drift in ${e.drift.manifest}: ${e.drift.summary}`
        : `session ${e.sessionId}: ${e.type}`,
  );
  writeJSON(dir, "Art.12-2-traceability.json", art12trace);
  files.push("eu-ai-act/Art.12-2-traceability.json");

  // Article 14(1) — Human oversight through approval gates
  const art14gate = buildControlEvidence(
    "Art.14(1)",
    "Human Oversight — Approval Gates",
    "High-risk AI systems shall be designed so they can be effectively overseen by natural persons. Human approval is requested and resolved before gated operations proceed.",
    events,
    (e) => e.type === "approval_requested" || e.type === "approval_resolved",
    (e) => `${e.type} [${e.approval?.state ?? e.outcome}]: ${e.approval?.reviewer ?? e.approval?.requiredRole ?? e.approval?.toolName ?? "pending"}`,
  );
  writeJSON(dir, "Art.14-1-approval-gates.json", art14gate);
  files.push("eu-ai-act/Art.14-1-approval-gates.json");

  // Article 14(4) — Ability to intervene, interrupt or halt the system. A
  // non-conformant action — one that strays outside the loaded skill's declared
  // action_scope — is held fail-closed and routed to a human, evidencing the
  // intervention capability at the granularity of a single procedural step (#39).
  const art14stop = buildControlEvidence(
    "Art.14(4)",
    "Human Oversight — Intervention and Stop",
    "Oversight measures shall enable the person to intervene or interrupt the system through a stop button or similar. Blocked calls, exceeded budgets, invalidated plans and out-of-scope procedure actions held for review evidence the halt capability.",
    events,
    (e) => e.outcome === "blocked" || e.type === "budget_exceeded" || e.type === "plan_invalidated" || e.type === "conformance_verdict",
    (e) => `[${e.type}] ${e.outcome}: ${shortDetail(e)}`,
  );
  writeJSON(dir, "Art.14-4-intervention-stop.json", art14stop);
  files.push("eu-ai-act/Art.14-4-intervention-stop.json");

  // Article 14(4)(c) — Correct interpretation of output (confidence adjudication)
  const art14verify = buildControlEvidence(
    "Art.14(4)(c)",
    "Human Oversight — Output Interpretation",
    "Oversight shall enable the person to correctly interpret the AI system's output. Outputs are adjudicated against confidence thresholds and routed for human review on failure.",
    events,
    (e) => e.type === "confidence_verdict",
    (e) => `${e.confidence?.task ?? "?"} — ${e.confidence?.passed ? "passed" : "failed"} (${e.confidence?.score ?? 0}/${e.confidence?.threshold ?? 0})${e.confidence?.ticketId ? ` → ${e.confidence.ticketId}` : ""}`,
  );
  writeJSON(dir, "Art.14-4c-output-interpretation.json", art14verify);
  files.push("eu-ai-act/Art.14-4c-output-interpretation.json");

  // Summary report
  const report = generateReport(
    "EU AI Act — Evidence Summary (Art. 12 Record-Keeping, Art. 14 Human Oversight)",
    summary,
    [art12log, art12trace, art14gate, art14stop, art14verify],
    org,
  );
  writeFile(dir, "summary.md", report);
  files.push("eu-ai-act/summary.md");

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
  if (e.conformance) return conformanceDetail(e);
  if (e.skill) return `skill "${e.skill.id}" ${e.skill.eligible ? "eligible" : "ineligible"}: ${e.skill.reason}`;
  if (e.drift) return `drift in ${e.drift.manifest}`;
  if (e.budget) return `budget ${e.budget.totals?.USDC ?? 0}/${e.budget.ceiling?.amount ?? "∞"}`;
  if (e.governance) return e.governance.reason;
  if (e.toolCall) return `${e.toolCall.name}`;
  return e.type;
}

/** Render a skill event's evidence detail (id, eligibility, gate reason). */
function skillDetail(e: AuditEvent): string {
  if (!e.skill) return shortDetail(e);
  return `skill "${e.skill.id}" ${e.skill.eligible ? "loaded" : "skipped"} — ${e.skill.gate}: ${e.skill.reason}`;
}

/** Render a conformance verdict's evidence detail (skill, action, hold reason). */
function conformanceDetail(e: AuditEvent): string {
  if (!e.conformance) return shortDetail(e);
  const c = e.conformance;
  const act = `${c.tool ?? "?"}${c.target && c.target !== c.tool ? ` → ${c.target}` : ""}`;
  return `skill "${c.skillId}" action ${act}: ${c.passed ? "conformant" : "held"} — ${c.reason}${c.ticketId ? ` → ${c.ticketId}` : ""}`;
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

/** Generic evidence-summary report generator (title + controls table + per-control sections). */
function generateReport(
  title: string,
  summary: AuditSummary,
  ctrls: ControlEvidence[],
  org?: string,
): string {
  const lines: string[] = [
    `# ${title}`,
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

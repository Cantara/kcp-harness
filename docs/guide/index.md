# What is KCP Harness?

KCP Harness is an **MCP compliance proxy** that enforces deterministic knowledge governance for any AI agent. It sits between an agent and its tools, intercepting knowledge-related calls and routing them through the [kcp-agent](https://github.com/Cantara/kcp-agent) planner before execution.

## The Problem

Today's AI coding agents (Claude Code, Cursor, Copilot, etc.) can read any file in your project. They can't prove:

- **Why** they read what they read
- **What** they didn't read (and why)
- That they **stayed within budget**
- That the knowledge was **temporally valid** when accessed

For enterprises that need defensible, auditable AI workflows, this is a gap.

## The Solution

KCP Harness adds a compliance layer between the agent and its tools:

```
Agent (Claude Code / Cursor / Copilot / ...)
  │
  │  MCP tool call
  v
┌─────────────────────────────────────┐
│  kcp-harness (MCP proxy)            │
│                                     │
│  1. Receive tool call               │
│  2. Classify: knowledge-nav? Y/N    │
│  3. If Y → 13-gate cascade          │
│     • audience / temporal / budget   │
│     • decision trace → audit log    │
│  4. If N → pass through             │
│  5. Return result + metadata        │
└─────────────────────────────────────┘
  │
  v
Knowledge manifests (knowledge.yaml)
```

The agent can't bypass governance because it only talks to the proxy's MCP interface. The proxy decides what knowledge is accessible, tracks spend, and logs every decision.

## Key Properties

| Property | What it means |
|---|---|
| **Deterministic** | Same inputs → same plan. No model involved in knowledge selection. |
| **Fail-closed** | If the harness can't verify a request, it blocks it. No silent fallback. |
| **Audit-first** | Every decision produces a compliance artifact. Even pass-throughs are logged. |
| **Agent-agnostic** | Works with any MCP-capable agent. One config per agent. |
| **Session-aware** | Tracks loaded knowledge across calls. Dedup prevents redundant loads. |

## Three-Layer Architecture

```
┌──────────────────────────────────────────────┐
│  Layer 3: Integration Packages               │
│  Agent-specific configs + rules files        │
├──────────────────────────────────────────────┤
│  Layer 2: KCP Compliance Harness             │  ← THIS
│  MCP proxy — deterministic governance        │
├──────────────────────────────────────────────┤
│  Layer 1: kcp-agent (planner core)           │
│  13-gate cascade, decision traces            │
└──────────────────────────────────────────────┘
```

## Next Steps

- [Installation](./installation) — install via npm or native binary
- [Quick Start](./quick-start) — get governance running in 5 minutes
- [Architecture](./architecture) — deep dive into the proxy pipeline

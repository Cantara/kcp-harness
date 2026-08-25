# kcp-harness

MCP compliance proxy: routes an AI agent's knowledge-related tool calls through the
[kcp-agent](https://github.com/Cantara/kcp-agent) deterministic planner (14-gate cascade, no
LLM), producing decision traces, audit logs, and budget ledgers as a side effect of normal
agent operation. Ships as an npm package plus native binaries, with integration generators for
Claude Code, Cursor, Copilot, and others.

## Start here

`knowledge.yaml` is this repo's canonical, agent-navigable source of truth (signed via
`knowledge.yaml.sig`; the repo dogfoods its own governance through `harness.yaml`). Query it
before grepping: `npx kcp-agent plan "how does the harness govern a tool call?" --manifest .`

## Skills

Governed-skill authoring conventions (envelope shape, `action_scope` as a firewall rule) live in
[Cantara/kcp-skill](https://github.com/Cantara/kcp-skill) `PROFILE.md` — read before writing or
reviewing any `kind: skill` unit here. This repo's own `skills/` holds procedures specific to
operating kcp-harness (shared library content is federated from kcp-skill, never copied):
- `cut-a-release` — the two-workflow release handoff (`release.yml` → `ci.yml`)
- `resign-knowledge-yaml` — recover an invalidated `knowledge.yaml.sig` on a PR branch

## Gotchas

- Editing `knowledge.yaml` invalidates `knowledge.yaml.sig`; CI checks it on the PR itself, so
  merging to `main` won't fix an already-red check.
- Releases aren't a plain `git tag && push` — see `skills/cut-a-release/` first.
- Raw NUL bytes break node/bun parity (issue #51); `scripts/check-nul-bytes.sh` enforces this.

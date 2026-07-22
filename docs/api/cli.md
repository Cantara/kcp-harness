# CLI Commands

## `kcp-harness serve`

Start the MCP compliance proxy. Reads from stdin, writes to stdout (MCP stdio transport).

```bash
kcp-harness serve [--config harness.yaml]
```

| Flag | Default | Description |
|---|---|---|
| `--config` | `harness.yaml` | Path to harness configuration file |

The proxy runs until stdin closes (the agent disconnects). All governance decisions are logged to the audit log.

## `kcp-harness init`

Create a `harness.yaml` template in the current directory.

```bash
kcp-harness init [--config custom-name.yaml]
```

Refuses to overwrite an existing file.

## `kcp-harness check`

Validate the harness configuration and print the parsed config as JSON.

```bash
kcp-harness check [--config harness.yaml]
```

Exits with code 0 if valid, 1 if invalid.

## `kcp-harness integrate`

Generate agent-specific integration files.

```bash
# Generate for a specific agent
kcp-harness integrate <agent> [options]

# List all supported agents
kcp-harness integrate --list

# Preview without writing files
kcp-harness integrate <agent> --dry-run
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--manifest` | `./knowledge.yaml` | Path to knowledge manifest |
| `--config` | — | Path to harness config |
| `--command` | `npx` | Custom harness command |
| `--paths` | `docs/,src/` | Comma-separated governed path prefixes |
| `--out` | `.` | Output directory |
| `--dry-run` | — | Print files to stdout instead of writing |

### Supported Agents

```
claude-code    cursor    copilot    copilot-cli
windsurf       cline     continue   crush
openclaw
```

## `kcp-harness approvals`

The built-in review channel for human-approval tickets (the `file` provider). The proxy opens
tickets; a human resolves them here — from any terminal, in any process, before or after a
harness restart.

```bash
# List tickets (optionally by state)
kcp-harness approvals list [--state pending_review]

# Approve — reviewer and policy citation are REQUIRED, never anonymous
kcp-harness approvals approve <id> --reviewer "Kari N." --policy-ref POL-7.2 [--note "..."]

# Dismiss — same evidence requirements, terminal outcome
kcp-harness approvals dismiss <id> --reviewer "Kari N." --policy-ref POL-7.2 [--note "redo the analysis"]

# Signed resolution (non-repudiation) — optionally required by
# governance.approvals.require_signed_resolutions in harness.yaml, see
# guide/configuration.md
kcp-harness approvals approve <id> --reviewer "Kari N." --policy-ref POL-7.2 \
  --private-key ./reviewer-key.pem [--key-id kari-2026]
```

| Flag | Required | Description |
|---|---|---|
| `--state` | No | Filter `list` by ticket state |
| `--reviewer` | Yes (approve/dismiss) | Named human resolving the ticket |
| `--policy-ref` | Yes (approve/dismiss) | Policy/regulatory citation the resolution satisfies |
| `--note` | No | Free-text note recorded on the resolution |
| `--private-key` | Only if `require_signed_resolutions` is on | Path to a PEM private key; signs the resolution for non-repudiation |
| `--key-id` | No | Key identifier recorded alongside the signature |
| `--config` | No | Harness config path (default `harness.yaml`) |

Every resolution is appended to the audit log as an `approval_resolved` event. When
`require_signed_resolutions` is on, an unsigned or invalid `--private-key` resolution is
rejected fail-closed; a valid one carries `[signed <key-id>]` in the ticket history.

## `kcp-harness export`

Generate compliance evidence bundles from the audit log — see [guide/compliance-export.md](../guide/compliance-export.md) for the full control mapping.

```bash
kcp-harness export --format both --org "Your Company" --from 2026-07-01 --to 2026-07-07 --out evidence/
```

| Flag | Required | Description |
|---|---|---|
| `--format` | No | `soc2`, `iso27001`, `iso42001`, `euaiact`, or `both` (soc2 + iso27001). Default `both`. |
| `--org` | No | Organization name for report headers |
| `--from` | No | Start date filter (ISO 8601) |
| `--to` | No | End date filter (ISO 8601) |
| `--out` | No | Output directory (default `evidence`) |
| `--audit` | No | Path to audit JSONL log (default from config or `.kcp-harness/audit.jsonl`) |
| `--config` | No | Harness config path (default `harness.yaml`) |

## `kcp-harness --version`

Print the version number.

## `kcp-harness --help`

Print usage information.

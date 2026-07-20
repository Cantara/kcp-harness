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
```

| Flag | Required | Description |
|---|---|---|
| `--state` | No | Filter `list` by ticket state |
| `--reviewer` | Yes (approve/dismiss) | Named human resolving the ticket |
| `--policy-ref` | Yes (approve/dismiss) | Policy/regulatory citation the resolution satisfies |
| `--note` | No | Free-text note recorded on the resolution |
| `--config` | No | Harness config path (default `harness.yaml`) |

Every resolution is appended to the audit log as an `approval_resolved` event.

## `kcp-harness --version`

Print the version number.

## `kcp-harness --help`

Print usage information.

# Agent Integrations

KCP Harness works with any MCP-capable AI agent. Each agent has its own config format, rules file, and setup pattern. The `kcp-harness integrate` command generates the right files for your agent.

## Supported Agents

| Agent | Config File | Rules File | Notes |
|---|---|---|---|
| [Claude Code](./claude-code) | `.mcp.json` | `CLAUDE.md` + hooks | PreToolUse hooks block ungoverned reads |
| [Cursor](./cursor) | `.cursor/mcp.json` | `.cursor/rules/*.mdc` | Glob-scoped rules with YAML frontmatter |
| [GitHub Copilot](./copilot) | `.vscode/mcp.json` | `.github/copilot-instructions.md` | Uses `"servers"` key (not `"mcpServers"`) |
| [Windsurf](./windsurf) | Global config | `.windsurfrules` | Global MCP config, not per-project |
| [Cline](./cline) | MCP settings UI | `.clinerules` | Auto-approve for read-only tools |
| [Continue](./continue) | `.continue/mcpServers/*.yaml` | — | YAML format, directory-based |
| [Crush](./crush) | `crush.json` | — | PrepareStep for knowledge pre-loading |
| [OpenClaw](./openclaw) | `openclaw.json` | — | Plugin hooks for prompt injection |

## Quick Setup

```bash
# Generate integration files for your agent
kcp-harness integrate claude-code
kcp-harness integrate cursor
kcp-harness integrate copilot

# Preview without writing files
kcp-harness integrate claude-code --dry-run

# List all supported agents
kcp-harness integrate --list

# Custom options
kcp-harness integrate cursor \
  --manifest ./docs/knowledge.yaml \
  --paths "docs/,fragments/"
```

## How It Works

Each integration package generates:

1. **MCP config** — tells the agent where to find the kcp-harness server
2. **Rules file** (if applicable) — instructs the agent to use `kcp_load` for governed knowledge
3. **Setup instructions** — agent-specific steps to complete the integration

The harness itself is the same regardless of agent. The integration layer handles agent-specific config formats and conventions.

## MCP Config Key Differences

Most agents use `"mcpServers"` as the top-level key, but there are exceptions:

```json
// Most agents (Claude Code, Cursor, Cline, Crush, OpenClaw)
{ "mcpServers": { "kcp-harness": { ... } } }

// GitHub Copilot (VS Code)
{ "servers": { "kcp-harness": { ... } } }

// Windsurf — global config at ~/.codeium/windsurf/mcp_config.json
{ "mcpServers": { "kcp-harness": { ... } } }
```

The `kcp-harness integrate` command handles these differences automatically.

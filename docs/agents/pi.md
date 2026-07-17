# Pi integration

`kcp-harness integrate pi` generates project-local Pi configuration:

- `.pi/mcp.json` with a lazy `kcp-harness` MCP server and `directTools: false`;
- `.pi/skills/kcp-harness/SKILL.md` teaching the agent to use `kcp_plan`, `kcp_load`, and harness diagnostics.

## Prerequisite: an MCP client extension

Stock Pi ships without an MCP client ("No MCP" is a stated Pi design choice), so
`.pi/mcp.json` on its own does nothing. Install an MCP client extension first, for
example:

```bash
pi install npm:pi-mcp-adapter
```

The generated `.pi/mcp.json` uses that adapter's format (`settings.toolPrefix`,
`settings.directTools`, per-server `lifecycle: lazy`). The generated skill loads
independently of MCP — Pi discovers `.pi/skills/` once the project is trusted — and
tells the agent to ask the operator for the adapter rather than bypass governance
when the `kcp_plan`/`kcp_load` tools are missing.

Preview before writing:

```bash
kcp-harness integrate pi --dry-run
```

Generate with a custom manifest and governed paths:

```bash
kcp-harness integrate pi \
  --manifest ./knowledge.yaml \
  --paths "docs/,src/"
```

The integration does not install Pi, modify global Pi settings, or reimplement governance. Review the generated files before committing them. Re-running the command is idempotent for the generated files.

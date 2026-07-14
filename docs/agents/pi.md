# Pi integration

`kcp-harness integrate pi` generates project-local Pi configuration:

- `.pi/mcp.json` with a lazy `kcp-harness` MCP server and `directTools: false`;
- `.pi/skills/kcp-harness/SKILL.md` teaching the agent to use `kcp_plan`, `kcp_load`, and harness diagnostics.

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

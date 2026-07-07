# Continue

Continue loads MCP servers from YAML files in the `.continue/mcpServers/` directory.

## Setup

```bash
kcp-harness integrate continue
```

This generates:

### `.continue/mcpServers/kcp-harness.yaml`

```yaml
name: KCP Compliance Harness
version: 0.1.0
schema: v1
mcpServers:
  - name: kcp-harness
    command: npx
    args:
      - "kcp-harness"
      - "serve"
```

Place this file in your project's `.continue/mcpServers/` directory and restart Continue. It will auto-discover the kcp-harness server.

## Notes

- Continue uses **YAML format** (not JSON) for directory-based MCP server configs
- Use Agent mode to access kcp-harness tools (`kcp_plan`, `kcp_load`, etc.)
- No separate rules file is needed — governance is enforced by the harness proxy regardless

# Installation

## npm (recommended)

```bash
npm install -g kcp-harness
```

Or use without installing:

```bash
npx kcp-harness --help
```

## Native Binaries

Pre-built binaries are available for every release on [GitHub Releases](https://github.com/Cantara/kcp-harness/releases):

| Platform | Binary |
|---|---|
| Linux x64 | `kcp-harness-linux-x64` |
| Linux ARM64 | `kcp-harness-linux-arm64` |
| macOS x64 | `kcp-harness-macos-x64` |
| macOS ARM64 (Apple Silicon) | `kcp-harness-macos-arm64` |
| Windows x64 | `kcp-harness-windows-x64.exe` |

Download and make executable:

```bash
curl -fsSL https://github.com/Cantara/kcp-harness/releases/latest/download/kcp-harness-linux-x64 \
  -o kcp-harness
chmod +x kcp-harness
./kcp-harness --version
```

### Verify checksums

Each release includes `SHA256SUMS.txt`:

```bash
curl -fsSL https://github.com/Cantara/kcp-harness/releases/latest/download/SHA256SUMS.txt \
  -o SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt --ignore-missing
```

## From Source

```bash
git clone https://github.com/Cantara/kcp-harness.git
cd kcp-harness
npm install
npm run build
node dist/cli.js --help
```

## Prerequisites

- **Node.js 20+** (for npm install)
- **kcp-agent** — the deterministic planner (installed as a dependency)
- A `knowledge.yaml` manifest in your project (see [Quick Start](./quick-start))

## Verify Installation

```bash
kcp-harness --version
# kcp-harness 0.1.0
```

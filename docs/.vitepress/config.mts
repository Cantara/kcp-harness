import { defineConfig } from "vitepress";

export default defineConfig({
  title: "KCP Harness",
  description:
    "Deterministic knowledge governance for any AI agent — MCP compliance proxy",
  base: "/kcp-harness/",
  lastUpdated: true,

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/kcp-harness/logo.svg" }],
  ],

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Agents", link: "/agents/" },
      { text: "API", link: "/api/" },
      {
        text: "Resources",
        items: [
          {
            text: "GitHub",
            link: "https://github.com/Cantara/kcp-harness",
          },
          {
            text: "kcp-agent",
            link: "https://github.com/Cantara/kcp-agent",
          },
          {
            text: "Releases",
            link: "https://github.com/Cantara/kcp-harness/releases",
          },
        ],
      },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Introduction",
          items: [
            { text: "What is KCP Harness?", link: "/guide/" },
            { text: "Installation", link: "/guide/installation" },
            { text: "Quick Start", link: "/guide/quick-start" },
          ],
        },
        {
          text: "Core Concepts",
          items: [
            { text: "Architecture", link: "/guide/architecture" },
            { text: "Configuration", link: "/guide/configuration" },
            { text: "Governance Model", link: "/guide/governance" },
          ],
        },
        {
          text: "Enterprise",
          items: [
            { text: "Compliance Export", link: "/guide/compliance-export" },
          ],
        },
      ],
      "/agents/": [
        {
          text: "Agent Integrations",
          items: [
            { text: "Overview", link: "/agents/" },
            { text: "Claude Code", link: "/agents/claude-code" },
            { text: "Cursor", link: "/agents/cursor" },
            { text: "GitHub Copilot", link: "/agents/copilot" },
            { text: "Windsurf", link: "/agents/windsurf" },
            { text: "Cline", link: "/agents/cline" },
            { text: "Continue", link: "/agents/continue" },
            { text: "Crush", link: "/agents/crush" },
            { text: "OpenClaw", link: "/agents/openclaw" },
          ],
        },
      ],
      "/api/": [
        {
          text: "API Reference",
          items: [
            { text: "Overview", link: "/api/" },
            { text: "CLI Commands", link: "/api/cli" },
            { text: "MCP Tools", link: "/api/mcp-tools" },
            { text: "Audit Log", link: "/api/audit" },
            { text: "Budget Tracking", link: "/api/budget" },
            { text: "Temporal Governance", link: "/api/temporal" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/Cantara/kcp-harness" },
    ],

    footer: {
      message: "Released under the Apache 2.0 License.",
      copyright: "Copyright 2025-present Cantara",
    },

    editLink: {
      pattern:
        "https://github.com/Cantara/kcp-harness/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    search: {
      provider: "local",
    },
  },
});

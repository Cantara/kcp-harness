// Downstream MCP server management — spawn, initialize, and proxy to
// downstream MCP servers over stdio.
//
// The harness acts as an MCP client to each downstream server. It:
// 1. Spawns the server as a child process with stdio pipes
// 2. Performs the MCP initialization handshake
// 3. Collects the server's tool list
// 4. Routes tool calls to the appropriate downstream
// 5. Cleans up on shutdown
//
// Each downstream connection handles JSON-RPC 2.0 over newline-delimited
// stdio — the standard MCP framing. Request/response correlation uses
// monotonic integer IDs.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { DownstreamConfig } from "./config.js";

const HARNESS_VERSION = "0.1.0";
const INIT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;

/** An MCP tool descriptor (matches MCP spec). */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** A live connection to a downstream MCP server. */
export interface DownstreamConnection {
  name: string;
  config: DownstreamConfig;
  process: ChildProcess;
  readline: Interface;
  tools: McpTool[];
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  alive: boolean;
}

/** Manages the lifecycle of downstream MCP servers. */
export class DownstreamManager {
  private connections: DownstreamConnection[] = [];
  /** Map from tool name → downstream connection that owns it. */
  private toolOwners = new Map<string, DownstreamConnection>();

  /** Spawn and initialize a downstream MCP server. */
  async add(config: DownstreamConfig): Promise<DownstreamConnection> {
    const conn = this.spawn(config);
    await this.initialize(conn);
    this.connections.push(conn);

    // Register tool ownership
    for (const tool of conn.tools) {
      if (this.toolOwners.has(tool.name)) {
        // Name collision — prefix with downstream name
        const prefixed = `${config.name}__${tool.name}`;
        this.toolOwners.set(prefixed, conn);
      } else {
        this.toolOwners.set(tool.name, conn);
      }
    }

    return conn;
  }

  /** Get all tools from all downstream servers. */
  allTools(): McpTool[] {
    const tools: McpTool[] = [];
    for (const conn of this.connections) {
      tools.push(...conn.tools);
    }
    return tools;
  }

  /** Find which downstream owns a tool. */
  ownerOf(toolName: string): DownstreamConnection | undefined {
    return this.toolOwners.get(toolName);
  }

  /** Call a tool on the downstream that owns it. */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
    const conn = this.toolOwners.get(toolName);
    if (!conn) throw new Error(`no downstream owns tool: ${toolName}`);
    if (!conn.alive) throw new Error(`downstream ${conn.name} is not alive`);

    const result = await this.rpc(conn, "tools/call", {
      name: toolName,
      arguments: args,
    });

    return result as { content: Array<{ type: string; text: string }>; isError: boolean };
  }

  /** Shut down all downstream connections. */
  async shutdown(): Promise<void> {
    for (const conn of this.connections) {
      conn.alive = false;
      conn.readline.close();
      conn.process.kill("SIGTERM");

      // Clear pending requests
      for (const [, p] of conn.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("downstream shutting down"));
      }
      conn.pending.clear();
    }
    this.connections = [];
    this.toolOwners.clear();
  }

  // -- Internal lifecycle ---------------------------------------------------

  private spawn(config: DownstreamConfig): DownstreamConnection {
    const proc = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
    });

    if (!proc.stdout || !proc.stdin) {
      throw new Error(`failed to spawn downstream ${config.name}: no stdio`);
    }

    const rl = createInterface({ input: proc.stdout, terminal: false });
    const conn: DownstreamConnection = {
      name: config.name,
      config,
      process: proc,
      readline: rl,
      tools: [],
      nextId: 1,
      pending: new Map(),
      alive: true,
    };

    // Wire up response handling
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: { message: string } };
        if (msg.id !== undefined && msg.id !== null) {
          const p = conn.pending.get(Number(msg.id));
          if (p) {
            conn.pending.delete(Number(msg.id));
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        }
      } catch {
        // Ignore unparseable lines (stderr leaking into stdout, etc.)
      }
    });

    proc.on("exit", () => {
      conn.alive = false;
      // Reject all pending requests
      for (const [, p] of conn.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`downstream ${config.name} exited`));
      }
      conn.pending.clear();
    });

    return conn;
  }

  private async initialize(conn: DownstreamConnection): Promise<void> {
    // MCP initialization handshake
    const initResult = (await this.rpc(
      conn,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "kcp-harness", version: HARNESS_VERSION },
      },
      INIT_TIMEOUT_MS,
    )) as Record<string, unknown>;

    // Send initialized notification
    this.notify(conn, "notifications/initialized");

    // List tools
    const toolsResult = (await this.rpc(conn, "tools/list", {}, INIT_TIMEOUT_MS)) as {
      tools: McpTool[];
    };
    conn.tools = toolsResult.tools ?? [];
  }

  // -- JSON-RPC transport ---------------------------------------------------

  private rpc(
    conn: DownstreamConnection,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = conn.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    conn.process.stdin!.write(msg + "\n");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`timeout waiting for ${method} from ${conn.name}`));
      }, timeoutMs);

      conn.pending.set(id, { resolve, reject, timer });
    });
  }

  private notify(conn: DownstreamConnection, method: string, params?: Record<string, unknown>): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    conn.process.stdin!.write(msg + "\n");
  }
}

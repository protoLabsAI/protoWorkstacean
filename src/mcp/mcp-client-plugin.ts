/**
 * McpClientPlugin — connects to MCP servers and registers their tools as
 * executors (ADR-0005 P4). The MCP client tier, mirroring SkillBrokerPlugin's
 * A2A reconcile shape (ADR-0004 P3 day-4).
 *
 * On install it reads workspace/mcp-servers.d/*.yaml, and for each ENABLED
 * server (trust-tier gate, ADR-0005 D2) connects one shared Client, lists its
 * tools, and registers one McpExecutor per tool with the ExecutorRegistry under
 * skill name "<server>.<tool>" + agentName "<server>". command.mcp.upsert/remove
 * reconcile live — no restart.
 *
 * Connecting is fire-and-forget off the bus turn (like SkillBroker's discovery):
 * an unreachable/slow server never blocks reconcile; its tools simply don't
 * register and the failure logs loudly.
 *
 * This plugin is a registrar only — SkillDispatcherPlugin remains the sole
 * subscriber to agent.skill.request.
 *
 * Config: workspace/mcp-servers.d/<name>.yaml (control-plane-managed).
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import type { McpServerDef } from "./types.ts";
import { McpExecutor } from "./mcp-executor.ts";
import { resolveServerConfig, connectMcp, toolAllowed, mcpEnabled } from "./mcp-connect.ts";

/** The registry skill name for an MCP tool — namespaced by server to avoid collisions. */
export function mcpSkillName(serverName: string, toolName: string): string {
  return `${serverName}.${toolName}`;
}

export class McpClientPlugin implements Plugin {
  readonly name = "mcp-client";
  readonly description = "Connects to MCP servers and registers their tools as executors (ADR-0005)";
  readonly capabilities = ["executor-registrar", "mcp-client"];

  private readonly workspaceDir: string;
  private readonly executorRegistry: ExecutorRegistry;
  private bus?: EventBus;
  /** Live connected clients, one per server, owned here (closed on unregister/uninstall). */
  private readonly clients = new Map<string, Client>();

  constructor(workspaceDir: string, executorRegistry: ExecutorRegistry) {
    this.workspaceDir = workspaceDir;
    this.executorRegistry = executorRegistry;
  }

  install(bus: EventBus): void {
    this.bus = bus;
    const defs = this._loadServers();
    for (const def of defs) this._registerServer(def);
    console.log(`[mcp-client] Reconciling ${defs.length} MCP server(s) from mcp-servers.d/ (tools connect async)`);

    bus.subscribe("command.mcp.upsert", this.name, (msg: BusMessage) => {
      const entry = (msg.payload as { entry?: McpServerDef })?.entry;
      if (entry?.name) this._registerServer(entry);
    });
    bus.subscribe("command.mcp.remove", this.name, (msg: BusMessage) => {
      const name = (msg.payload as { name?: string })?.name;
      if (name) void this._unregisterServer(name);
    });
  }

  uninstall(): void {
    for (const name of [...this.clients.keys()]) void this._unregisterServer(name);
  }

  /**
   * Register (or re-register) a server: skip if disabled, else connect + list
   * tools + register one executor per tool. Idempotent — unregisters first.
   * The connect is fire-and-forget so a slow/dead server never blocks the turn.
   */
  private _registerServer(def: McpServerDef): void {
    void this._unregisterServer(def.name).then(() => {
      if (!mcpEnabled(def)) {
        console.log(`[mcp-client] "${def.name}" registered but disabled (trust=${def.trust ?? "community"}) — set enabled:true to connect`);
        return;
      }
      return this._connectAndRegister(def);
    });
  }

  private async _connectAndRegister(def: McpServerDef): Promise<void> {
    const cfg = resolveServerConfig(def);
    try {
      const client = await connectMcp(cfg);
      this.clients.set(def.name, client);
      const { tools } = await client.listTools();
      let registered = 0;
      for (const tool of tools) {
        if (!toolAllowed(cfg, tool.name)) continue;
        const executor = new McpExecutor(client, def.name, tool.name, tool.description);
        this.executorRegistry.register(mcpSkillName(def.name, tool.name), executor, {
          agentName: def.name,
          priority: 5,
        });
        registered++;
      }
      console.log(`[mcp-client] "${def.name}" connected — registered ${registered}/${tools.length} tool(s)`);
    } catch (err) {
      // Loud failure at the boundary (per feedback_fail_fast_and_loud): a server
      // that won't connect registers no tools, and silence would hide it.
      this.clients.delete(def.name);
      console.warn(`[mcp-client] "${def.name}" connect failed — no tools registered: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Unregister every tool a server owns + close its client. */
  private async _unregisterServer(name: string): Promise<void> {
    for (const reg of this.executorRegistry.list()) {
      if (reg.agentName === name && reg.skill) this.executorRegistry.unregister(reg.skill, name);
    }
    const client = this.clients.get(name);
    if (client) {
      this.clients.delete(name);
      await client.close().catch(() => {});
      console.log(`[mcp-client] - MCP server "${name}" disconnected + unregistered`);
    }
  }

  /** Control-plane-managed MCP servers: one McpServerDef per file in workspace/mcp-servers.d/. */
  private _loadServers(): McpServerDef[] {
    const dir = join(this.workspaceDir, "mcp-servers.d");
    if (!existsSync(dir)) return [];
    const out: McpServerDef[] = [];
    try {
      for (const f of readdirSync(dir)) {
        if (!(f.endsWith(".yaml") || f.endsWith(".yml")) || f.endsWith(".example")) continue;
        try {
          const def = parseYaml(readFileSync(join(dir, f), "utf8")) as McpServerDef;
          if (def?.name) out.push(def);
          else console.warn(`[mcp-client] mcp-servers.d/${f}: missing name — skipped`);
        } catch (err) {
          console.error(`[mcp-client] Skipping mcp-servers.d/${f}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch { /* dir vanished mid-scan */ }
    return out;
  }
}

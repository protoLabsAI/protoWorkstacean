/**
 * MCP connection helpers (ADR-0005 P4) — shared by McpClientPlugin (live tool
 * registration) and the control-plane probe (POST /api/mcp-servers/test).
 *
 * Centralizes the bits that touch the @modelcontextprotocol/sdk client so a SDK
 * change is one file: config resolution (defaults + env interpolation + the
 * trust-tier enable gate), connecting a transport, and a bounded probe.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { resolveEnvVars } from "../utils/env-interpolation.ts";
import type { McpServerDef, McpServerConfig, McpProbeResult, TrustTier } from "./types.ts";

const CONNECT_TIMEOUT_MS = 8_000;

/**
 * Effective enabled state (ADR-0005 D2): explicit `enabled` wins; otherwise
 * builtin/trusted auto-enable and community stays off until the operator opts in.
 */
export function mcpEnabled(def: Pick<McpServerDef, "trust" | "enabled">): boolean {
  if (typeof def.enabled === "boolean") return def.enabled;
  const trust: TrustTier = def.trust ?? "community";
  return trust === "builtin" || trust === "trusted";
}

/** Resolve a raw server def into a runtime config: defaults, merged command, interpolated env. */
export function resolveServerConfig(def: McpServerDef): McpServerConfig {
  const trust: TrustTier = def.trust ?? "community";
  const transport = def.transport ?? "stdio";

  // command + args merge into a single argv (command[0] is the executable).
  const command = (def.command?.length ? [...def.command, ...(def.args ?? [])] : def.args) ?? undefined;

  let env: Record<string, string> | undefined;
  if (def.env) {
    env = {};
    for (const [k, v] of Object.entries(def.env)) env[k] = resolveEnvVars(v, "mcp-client");
  }

  return {
    name: def.name,
    trust,
    transport,
    command,
    env,
    url: def.url ? resolveEnvVars(def.url, "mcp-client") : undefined,
    grants: Array.isArray(def.grants) ? def.grants : [],
    allowedTools: def.allowedTools,
    excludeTools: def.excludeTools,
    enabled: mcpEnabled(def),
    description: def.description,
  };
}

/** Whether a tool name passes the server's allow/exclude filter (exclude wins). */
export function toolAllowed(cfg: McpServerConfig, toolName: string): boolean {
  if (cfg.excludeTools?.includes(toolName)) return false;
  if (cfg.allowedTools && cfg.allowedTools.length > 0) return cfg.allowedTools.includes(toolName);
  return true;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.()),
  ]);
}

/** Build a transport for the config + connect a fresh MCP client. Throws on failure/timeout. */
export async function connectMcp(cfg: McpServerConfig): Promise<Client> {
  const client = new Client({ name: "protoworkstacean", version: "1.0.0" });
  let transport;
  if (cfg.transport === "sse") {
    if (!cfg.url) throw new Error(`MCP server "${cfg.name}" uses sse transport but has no url`);
    transport = new SSEClientTransport(new URL(cfg.url));
  } else {
    const command = cfg.command?.[0];
    if (!command) throw new Error(`MCP server "${cfg.name}" uses stdio transport but has no command`);
    transport = new StdioClientTransport({ command, args: cfg.command!.slice(1), env: cfg.env });
  }
  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect to "${cfg.name}"`);
  return client;
}

/** Connect, list tools, disconnect — capability discovery for test-before-save. Never throws. */
export async function probeMcpServer(def: McpServerDef): Promise<McpProbeResult> {
  const cfg = resolveServerConfig(def);
  const startedAt = Date.now();
  let client: Client | undefined;
  try {
    client = await connectMcp(cfg);
    const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `listTools "${cfg.name}"`);
    return {
      name: def.name,
      reachable: true,
      latencyMs: Date.now() - startedAt,
      tools: tools
        .filter((t) => toolAllowed(cfg, t.name))
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    };
  } catch (err) {
    return {
      name: def.name,
      reachable: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

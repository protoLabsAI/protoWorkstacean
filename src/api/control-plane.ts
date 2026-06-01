/**
 * GET /api/control-plane/state — the unified read of the control plane (ADR-0004 P5).
 *
 * The control plane has a write side (the command.* bus topics + agents-crud.ts,
 * driven by the Console) and, until now, a scattered read side: the live fleet
 * came from /api/agents/runtime while health lived only inside the
 * AgentFleetHealthPlugin with no HTTP exposure. This route unifies both into a
 * single snapshot so the Console (and any operator tool) can render "what is the
 * fleet, and how is it doing" in one fetch:
 *
 *   {
 *     success: true,
 *     data: {
 *       agents: AgentSummary[],            // live registry + declared A2A (pendingDiscovery)
 *       mcpServers: McpServerSummary[],    // registered MCP servers (ADR-0005 P4)
 *       health: FleetHealthSnapshot | null, // 24h rollups, durably-backed (P5a); null if the plugin isn't installed
 *       collectedAt: number,
 *     }
 *   }
 *
 * Health is read through the plugin's in-memory window, which is rehydrated from
 * knowledge.db on startup (P5a) — so the numbers survive restarts. This route is
 * read-only; all mutation flows through the command.* write API.
 */

import type { Route, ApiContext } from "./types.ts";
import { collectFleetAgents } from "./agents-runtime.ts";
import { listMcpServers } from "./mcp-crud.ts";
import type { AgentFleetHealthPlugin } from "../plugins/agent-fleet-health-plugin.ts";
import type { FleetHealthSnapshot } from "../plugins/agent-fleet-health-plugin.ts";

function fleetHealth(ctx: ApiContext): FleetHealthSnapshot | null {
  const plugin = ctx.plugins.find((p) => p.name === "agent-fleet-health");
  if (!plugin) return null;
  return (plugin as unknown as AgentFleetHealthPlugin).getFleetHealth();
}

export function createRoutes(ctx: ApiContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/control-plane/state",
      handler: () => {
        const health = fleetHealth(ctx);
        return Response.json({
          success: true,
          data: {
            agents: collectFleetAgents(ctx),
            mcpServers: listMcpServers(ctx.workspaceDir),
            health,
            collectedAt: health?.collectedAt ?? Date.now(),
          },
        });
      },
    },
  ];
}

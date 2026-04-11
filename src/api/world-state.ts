/**
 * World-state, services, agent-health, flow-metrics, and outcomes routes.
 * These query internal plugin state — no external API calls.
 */

import type { Route, ApiContext } from "./types.ts";
import type { TelemetryService } from "../telemetry/telemetry-service.ts";

interface WorldStateAPI {
  getWorldState(opts?: { domain?: string; maxAgeMs?: number }): unknown;
}

interface FlowMonitorAPI {
  getMetrics(opts?: { metric?: string }): unknown;
}

interface ActionDispatcherAPI {
  getOutcomes(): { getAll(): unknown[]; summary(): unknown; getRecent(n: number): unknown[] };
}

interface HITLPluginAPI {
  getQueueSnapshot(): { pendingCount: number; unrenderedCount: number };
}

function resolveGithubAuthType(): string | null {
  if (process.env.QUINN_APP_PRIVATE_KEY) return "app";
  if (process.env.GITHUB_TOKEN) return "token";
  return null;
}

export function createRoutes(ctx: ApiContext): Route[] {
  const wsEngine = ctx.plugins.find(p => p.name === "world-state-engine") as (WorldStateAPI & { name: string }) | undefined;
  const flowMonitor = ctx.plugins.find(p => p.name === "flow-monitor") as (FlowMonitorAPI & { name: string }) | undefined;
  const actionDispatcher = ctx.plugins.find(p => p.name === "action-dispatcher") as (ActionDispatcherAPI & { name: string }) | undefined;
  const hitlPlugin = ctx.plugins.find(p => p.name === "hitl") as (HITLPluginAPI & { name: string }) | undefined;

  function handleGetWorldState(domain?: string): Response {
    if (!wsEngine) return Response.json({ success: false, error: "world-state-engine not available" }, { status: 503 });
    const data = wsEngine.getWorldState(domain ? { domain, maxAgeMs: 120_000 } : { maxAgeMs: 120_000 });
    return Response.json({ success: true, data });
  }

  function handleGetFlowMetrics(metric?: string): Response {
    if (!flowMonitor) return Response.json({ success: false, error: "flow-monitor not available" }, { status: 503 });
    const data = flowMonitor.getMetrics(metric ? { metric } : undefined);
    return Response.json({ success: true, data, collectedAt: Date.now() });
  }

  function handleGetServices(): Response {
    const discord = ctx.plugins.find(p => p.name === "discord") as Record<string, unknown> | undefined;
    const discordClient = discord?.["client"] as { isReady(): boolean; user?: { tag: string } } | undefined;
    const discordReady = discordClient?.isReady() ?? false;

    return Response.json({
      discord: {
        configured: !!process.env.DISCORD_BOT_TOKEN,
        connected: discordReady,
        bot: discordReady ? discordClient?.user?.tag ?? null : null,
      },
      github: {
        configured: !!(process.env.GITHUB_TOKEN || process.env.QUINN_APP_PRIVATE_KEY),
        authType: resolveGithubAuthType(),
      },
      plane: {
        configured: !!process.env.PLANE_API_KEY,
        baseUrl: process.env.PLANE_BASE_URL || null,
      },
      gateway: {
        configured: !!process.env.LLM_GATEWAY_URL,
        url: process.env.LLM_GATEWAY_URL || null,
      },
      langfuse: {
        configured: !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
      },
      graphiti: {
        configured: !!process.env.GRAPHITI_URL,
        url: process.env.GRAPHITI_URL || null,
      },
    });
  }

  function handleGetAgentHealth(): Response {
    const registrations = ctx.executorRegistry.list();
    const agents: Record<string, { skills: string[]; executorType: string }> = {};
    for (const reg of registrations) {
      const name = reg.agentName ?? "_default";
      if (!agents[name]) agents[name] = { skills: [], executorType: reg.executor.type };
      if (reg.skill) agents[name].skills.push(reg.skill);
    }
    return Response.json({
      agentCount: Object.keys(agents).length,
      agents,
      registrationCount: registrations.length,
    });
  }

  function handleGetOutcomes(): Response {
    if (!actionDispatcher) return Response.json({ summary: { success: 0, failure: 0, timeout: 0, total: 0 }, recent: [] });
    const tracker = actionDispatcher.getOutcomes();
    return Response.json({ summary: tracker.summary(), recent: tracker.getRecent(50) });
  }

  function handleGetHitlQueue(): Response {
    if (!hitlPlugin) return Response.json({ pendingCount: 0, unrenderedCount: 0 });
    return Response.json(hitlPlugin.getQueueSnapshot());
  }

  async function handleGetMemoryHealth(): Promise<Response> {
    // Probes Graphiti's /healthcheck (200 = service up) and issues a
    // trivial /search (detects vector-function / embedder / neo4j
    // wiring issues that healthcheck alone doesn't catch). Exposed
    // as the `memory` domain so memory.graphiti_healthy can alert
    // when either side goes dark.
    const url = process.env.GRAPHITI_URL ?? "http://graphiti:8000";
    const result = { healthy: 0, searchOk: 0, error: "" };
    try {
      const hc = await fetch(`${url}/healthcheck`, { signal: AbortSignal.timeout(3_000) });
      if (hc.ok) result.healthy = 1;
      const search = await fetch(`${url}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "health probe", group_ids: ["user_josh"], max_facts: 1 }),
        signal: AbortSignal.timeout(5_000),
      });
      if (search.ok) result.searchOk = 1;
      else result.error = `search ${search.status}`;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    return Response.json(result);
  }

  function handleGetTelemetry(kind: "goal" | "action"): Response {
    if (!ctx.telemetry) return Response.json([]);
    return Response.json(ctx.telemetry.aggregate(kind));
  }

  function handleGetTelemetryUnused(kind: "goal" | "action", hoursParam?: string): Response {
    if (!ctx.telemetry) return Response.json([]);
    const hours = hoursParam ? Number(hoursParam) : 72;
    const maxQuietMs = Number.isFinite(hours) ? hours * 60 * 60 * 1000 : 72 * 60 * 60 * 1000;
    return Response.json(ctx.telemetry.unused(kind, maxQuietMs));
  }

  return [
    { method: "GET", path: "/api/world-state",          handler: () => handleGetWorldState() },
    { method: "GET", path: "/api/world-state/:domain",  handler: (_, p) => handleGetWorldState(p.domain) },
    { method: "GET", path: "/api/services",             handler: () => handleGetServices() },
    { method: "GET", path: "/api/agent-health",         handler: () => handleGetAgentHealth() },
    { method: "GET", path: "/api/flow-metrics",         handler: () => handleGetFlowMetrics() },
    { method: "GET", path: "/api/flow-metrics/:metric", handler: (_, p) => handleGetFlowMetrics(p.metric) },
    { method: "GET", path: "/api/outcomes",             handler: () => handleGetOutcomes() },
    { method: "GET", path: "/api/hitl-queue",           handler: () => handleGetHitlQueue() },
    { method: "GET", path: "/api/memory-health",        handler: () => handleGetMemoryHealth() },
    { method: "GET", path: "/api/telemetry/goals",      handler: () => handleGetTelemetry("goal") },
    { method: "GET", path: "/api/telemetry/actions",    handler: () => handleGetTelemetry("action") },
    {
      method: "GET",
      path: "/api/telemetry/unused/:kind",
      handler: (req, p) => {
        const kind = p.kind === "goal" || p.kind === "action" ? p.kind : null;
        if (!kind) return Response.json({ error: "kind must be 'goal' or 'action'" }, { status: 400 });
        const hours = new URL(req.url).searchParams.get("hours") ?? undefined;
        return handleGetTelemetryUnused(kind, hours);
      },
    },
  ];
}

import { existsSync, readdirSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { InMemoryEventBus } from "../lib/bus";
import { DebugPlugin } from "../lib/plugins/debug";
import { LoggerPlugin } from "../lib/plugins/logger";
import { CLIPlugin } from "../lib/plugins/cli";
import { SignalPlugin } from "../lib/plugins/signal";
import { SchedulerPlugin } from "../lib/plugins/scheduler";
import { ActionRegistry } from "./planner/action-registry";
import type { Plugin, } from "../lib/types";
import type { Action } from "./planner/types/action";
import { parseEnv } from "./config/env.ts";
// Fail-fast env validation — exits immediately on misconfiguration.
parseEnv();
// --- Workspace config ---
const workspaceDir = resolve(
  process.env.WORKSPACE_DIR || join(process.cwd(), "workspace")
);
if (!existsSync(workspaceDir)) {
  mkdirSync(workspaceDir, { recursive: true });
}

const dataDir = resolve(
  process.env.DATA_DIR || join(process.cwd(), "data")
);

const bus = new InMemoryEventBus();

// --- Context mailbox — mid-execution DM queue for debounced message injection ---
import { ContextMailbox } from "../lib/dm/context-mailbox.ts";
const contextMailbox = new ContextMailbox();

// --- Task tracker — tracks long-running A2A tasks that returned non-terminal state ---
import { TaskTracker } from "./executor/task-tracker.ts";
const taskTracker = new TaskTracker({ bus });

// --- ChannelRegistry — loaded from workspace/channels.yaml, shared by RouterPlugin + DiscordPlugin ---
import { ChannelRegistry } from "../lib/channels/channel-registry.js";
const channelRegistry = new ChannelRegistry(join(workspaceDir, "channels.yaml"));
channelRegistry.startWatching();

// --- Shared ActionRegistry — populated from workspace/actions.yaml ---
const actionRegistry = new ActionRegistry();

function loadActionsYaml(): void {
  const actionsPath = join(workspaceDir, "actions.yaml");
  if (!existsSync(actionsPath)) return;
  try {
    const raw = parseYaml(readFileSync(actionsPath, "utf8")) as { actions?: Record<string, unknown>[] };
    const actionsData = raw?.actions ?? [];
    for (const a of actionsData) {
      try {
        const action: Action = {
          id: a.id as string,
          name: a.name as string,
          description: (a.description as string) ?? "",
          goalId: a.goalId as string,
          tier: a.tier as Action["tier"],
          priority: typeof a.priority === "number" ? a.priority : 0,
          cost: typeof a.cost === "number" ? a.cost : 0,
          preconditions: Array.isArray(a.preconditions)
            ? (a.preconditions as Array<{ path: string; operator: string; value?: unknown }>).map((p) => ({
                path: p.path,
                operator: p.operator as Action["preconditions"][number]["operator"],
                value: p.value,
              }))
            : [],
          effects: Array.isArray(a.effects)
            ? (a.effects as Array<{ path: string; op?: string; operation?: string; value?: unknown }>).map((e) => ({
                path: e.path,
                operation: ((e.operation ?? e.op) as Action["effects"][number]["operation"]),
                value: e.value,
              }))
            : [],
          meta: typeof a.meta === "object" && a.meta !== null ? (a.meta as Action["meta"]) : {},
        };
        actionRegistry.upsert(action);
      } catch (err) {
        console.warn(`[actions-loader] Skipping invalid action '${a.id}':`, err);
      }
    }
    console.info(`[actions-loader] Loaded ${actionRegistry.size} action(s) from workspace/actions.yaml`);
  } catch (err) {
    console.error("[actions-loader] Failed to parse workspace/actions.yaml:", err);
  }
}
loadActionsYaml();

// --- Telemetry: per-goal and per-action counters persisted to knowledge.db ---
// Hosts the audit view ("is this action actually used?") exposed via
// /api/telemetry/* endpoints. Goal and action counters are bumped by the
// goal-evaluator and action-dispatcher respectively. Loaded actions are
// registered here at startup so zero-count rows exist for the audit.
import { TelemetryService, ACTION_EVENTS } from "./telemetry/telemetry-service.js";
const telemetry = new TelemetryService(`${dataDir}/knowledge.db`);
telemetry.init();
for (const action of actionRegistry.getAll()) {
  telemetry.registerKnown("action", action.id, ACTION_EVENTS);
}

// Core plugins — always loaded, statically imported (no dynamic overhead needed)
const debugPlugin = new DebugPlugin();
debugPlugin.install(bus);

const loggerPlugin = new LoggerPlugin(dataDir);

const corePlugins: Plugin[] = [
  debugPlugin,
  loggerPlugin,
  new CLIPlugin(),
  new SignalPlugin(),
  new SchedulerPlugin(dataDir),
];

for (const plugin of corePlugins) {
  plugin.install(bus);
}

// --- Plugin registry ---
// Each entry declares when to load and how to construct the plugin via dynamic
// import. This keeps startup cost proportional to what's actually enabled and
// makes the list of available integrations self-documenting.
//
// Future direction (per upstream feedback): each integration could become an
// independent microservice communicating via HTTP/WS — the condition/factory
// shape already supports swapping in an HTTP-client adapter per entry without
// changing the loading loop.

interface PluginRegistryEntry {
  name: string;
  condition: () => boolean;
  factory: () => Promise<Plugin>;
}

const enabledBuiltins = (process.env.ENABLED_PLUGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// Shared ExecutorRegistry — populated by AgentRuntimePlugin + SkillBrokerPlugin,
// consumed by SkillDispatcherPlugin (sole agent.skill.request subscriber).
const { ExecutorRegistry } = await import("./executor/executor-registry.js");
const executorRegistry = new ExecutorRegistry();

const pluginRegistry: PluginRegistryEntry[] = [
  {
    // RouterPlugin translates message.inbound.# and cron.# → agent.skill.request.
    name: "router",
    condition: () => true,
    factory: async () => {
      const { RouterPlugin } = await import("./router/router-plugin.js");
      return new RouterPlugin({ workspaceDir, channelRegistry });
    },
  },
  {
    name: "discord",
    condition: () => !!process.env.DISCORD_BOT_TOKEN,
    factory: async () => {
      const { DiscordPlugin } = await import("../lib/plugins/discord");
      return new DiscordPlugin({
        workspaceDir,
        dataDir,
        channelRegistry,
        hitlPlugin,
        mailbox: contextMailbox,
        isExecutionActive: (correlationId: string) => {
          const dispatcher = registeredPlugins.find(p => p.name === "skill-dispatcher");
          return !!(dispatcher as any)?.isActive?.(correlationId);
        },
      });
    },
  },
  {
    name: "github",
    condition: () => !!(process.env.GITHUB_TOKEN || process.env.GITHUB_APP_ID),
    factory: async () => {
      const { GitHubPlugin } = await import("../lib/plugins/github");
      return new GitHubPlugin(workspaceDir);
    },
  },
  {
    name: "plane",
    condition: () => true,
    factory: async () => {
      const { PlanePlugin } = await import("../lib/plugins/plane");
      return new PlanePlugin(workspaceDir);
    },
  },
  {
    name: "onboarding",
    condition: () => true,
    factory: async () => {
      const { OnboardingPlugin } = await import("../lib/plugins/onboarding");
      return new OnboardingPlugin(workspaceDir);
    },
  },
  {
    name: "plane-discord-notifier",
    condition: () => true,
    factory: async () => {
      const { PlaneDiscordNotifierPlugin } = await import("../lib/plugins/plane-discord-notifier");
      return new PlaneDiscordNotifierPlugin(workspaceDir);
    },
  },
  {
    name: "event-viewer",
    condition: () => !process.env.DISABLE_EVENT_VIEWER,
    factory: async () => {
      const { EventViewerPlugin } = await import("../lib/plugins/event-viewer");
      return new EventViewerPlugin();
    },
  },
  {
    name: "goal-evaluator",
    condition: () => true,
    factory: async () => {
      const { GoalEvaluatorPlugin } = await import("./plugins/goal_evaluator_plugin.js");
      return new GoalEvaluatorPlugin({ workspaceDir }, telemetry);
    },
  },
  {
    name: "planner-l0",
    condition: () => true,
    factory: async () => {
      const { PlannerPluginL0 } = await import("./plugins/planner-plugin-l0.js");
      return new PlannerPluginL0(actionRegistry);
    },
  },
  {
    // Registers ProtoSdkExecutors for workspace/agents/*.yaml into ExecutorRegistry.
    name: "agent-runtime",
    condition: () => true,
    factory: async () => {
      const { AgentRuntimePlugin } = await import("./agent-runtime/agent-runtime-plugin.js");
      return new AgentRuntimePlugin(
        {
          workspaceDir,
          apiBaseUrl: `http://localhost:${process.env.WORKSTACEAN_HTTP_PORT ?? "3000"}`,
          apiKey: process.env.WORKSTACEAN_API_KEY,
        },
        executorRegistry,
      );
    },
  },
  {
    // Registers A2AExecutors for workspace/agents.yaml into ExecutorRegistry.
    name: "skill-broker",
    condition: () => true,
    factory: async () => {
      const { SkillBrokerPlugin } = await import("./plugins/skill-broker-plugin.js");
      return new SkillBrokerPlugin(workspaceDir, executorRegistry);
    },
  },
  {
    // Intercepts ExecutorRegistry.resolve() to A/B test competing skill variants.
    // Must be installed AFTER registrars (agent-runtime, skill-broker) and
    // BEFORE skill-dispatcher so the hook is active when dispatches begin.
    name: "skill-ab-test",
    condition: () => true,
    factory: async () => {
      const { SkillAbTestPlugin } = await import("./executor/skill-ab-test-plugin.js");
      return new SkillAbTestPlugin(executorRegistry);
    },
  },
  {
    // Sole subscriber to agent.skill.request — dispatches via ExecutorRegistry.
    // Must be installed AFTER agent-runtime and skill-broker (registrars).
    name: "skill-dispatcher",
    condition: () => true,
    factory: async () => {
      const { SkillDispatcherPlugin } = await import("./executor/skill-dispatcher-plugin.js");
      return new SkillDispatcherPlugin(executorRegistry, workspaceDir, undefined, loggerPlugin, contextMailbox, taskTracker);
    },
  },
  {
    name: "ceremony",
    condition: () => true,
    factory: async () => {
      const { CeremonyPlugin } = await import("./plugins/CeremonyPlugin.js");
      return new CeremonyPlugin({ workspaceDir });
    },
  },
  {
    name: "world-state-engine",
    condition: () => true,
    factory: async () => {
      const { WorldStateEngine } = await import("../lib/plugins/world-state-engine.js");
      return new WorldStateEngine({ knowledgeDbPath: `${dataDir}/knowledge.db` });
    },
  },
  {
    name: "action-dispatcher",
    condition: () => true,
    factory: async () => {
      const { ActionDispatcherPlugin } = await import("./plugins/action-dispatcher-plugin.js");
      return new ActionDispatcherPlugin({ wipLimit: 5 }, telemetry);
    },
  },
  {
    name: "world-engine-alert",
    condition: () => true,
    factory: async () => {
      const { WorldEngineAlertPlugin } = await import("../lib/plugins/world-engine-alert.js");
      return new WorldEngineAlertPlugin();
    },
  },
  {
    name: "pr-remediator",
    condition: () => !!(process.env.QUINN_APP_PRIVATE_KEY || process.env.GITHUB_TOKEN),
    factory: async () => {
      const { PrRemediatorPlugin } = await import("../lib/plugins/pr-remediator.js");
      return new PrRemediatorPlugin();
    },
  },
  {
    name: "flow-monitor",
    condition: () => true,
    factory: async () => {
      const { FlowMonitorPlugin } = await import("../lib/plugins/flow-monitor.js");
      return new FlowMonitorPlugin();
    },
  },
  {
    name: "outcome-analysis",
    condition: () => true,
    factory: async () => {
      const { OutcomeAnalysisPlugin } = await import("./plugins/outcome-analysis-plugin.js");
      return new OutcomeAnalysisPlugin();
    },
  },
  {
    name: "agent-fleet-health",
    condition: () => true,
    factory: async () => {
      const { AgentFleetHealthPlugin } = await import("./plugins/agent-fleet-health-plugin.js");
      return new AgentFleetHealthPlugin();
    },
  },
  // Built-ins: opt-in via ENABLED_PLUGINS=echo,...
  {
    name: "echo",
    condition: () => enabledBuiltins.includes("echo"),
    factory: async () => {
      const { EchoPlugin } = await import("../lib/plugins/echo");
      return new EchoPlugin();
    },
  },
];

const registeredPlugins: Plugin[] = [];

// ── HITLPlugin — pre-installed so DiscordPlugin can register its renderer ──
const { HITLPlugin } = await import("../lib/plugins/hitl.js");
const hitlPlugin = new HITLPlugin(workspaceDir);
hitlPlugin.install(bus);
registeredPlugins.push(hitlPlugin);

for (const entry of pluginRegistry) {
  if (entry.condition()) {
    const plugin = await entry.factory();
    plugin.install(bus);
    registeredPlugins.push(plugin);
  }
}

// Guard: warn if skill-dispatcher is installed but no executor registrars ran.
// This happens when workspace/agents/*.yaml is empty AND workspace/agents.yaml has no entries.
{
  const hasDispatcher = registeredPlugins.some(p => p.name === "skill-dispatcher");
  const hasRegistrar = registeredPlugins.some(p =>
    p.name === "agent-runtime" || p.name === "skill-broker",
  );
  if (hasDispatcher && !hasRegistrar) {
    console.warn(
      "[startup] skill-dispatcher is installed but no executor registrar (agent-runtime / skill-broker) is active. " +
      "All agent.skill.request messages will be dropped. " +
      "Add workspace/agents/*.yaml or workspace/agents.yaml to register at least one agent.",
    );
  }
}

// --- Domain discovery — registers per-project HTTP domains + actions from projects.yaml ---
{
  const wsEngine = registeredPlugins.find(p => p.name === "world-state-engine");
  if (wsEngine) {
    const { discoverAndRegister } = await import("./world/domain-discovery.js");
    type WorldStateEngine = import("../lib/plugins/world-state-engine.js").WorldStateEngine;
    const projectsYamlPath = join(workspaceDir, "projects.yaml");
    const dr = discoverAndRegister(
      projectsYamlPath,
      wsEngine as unknown as WorldStateEngine,
      actionRegistry,
    );
    for (const err of dr.errors) console.warn(`[domain-discovery] ${err}`);
    console.log(`[domain-discovery] ${dr.domainsRegistered.length} domain(s) registered, ${dr.actionsLoaded} action(s) loaded`);

    // Local self-polling domains are registered AFTER Bun.serve() starts (see below)
    // to avoid "Unable to connect" on the initial immediate tick.
  }
}

// --- Dynamic plugin loading from workspace/plugins/ ---
function isPlugin(value: unknown): value is Plugin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Plugin).name === "string" &&
    typeof (value as Plugin).install === "function" &&
    typeof (value as Plugin).uninstall === "function"
  );
}

async function loadWorkspacePlugins(): Promise<Plugin[]> {
  const pluginsDir = join(workspaceDir, "plugins");
  if (!existsSync(pluginsDir)) return [];

  const loaded: Plugin[] = [];
  const files = readdirSync(pluginsDir).filter(
    (f) => extname(f) === ".ts" || extname(f) === ".js"
  );

  for (const file of files) {
    const modulePath = join(pluginsDir, file);
    try {
      const mod = await import(modulePath);
      // Check default export or named exports for Plugin interface.
      // Deduplicate: Object.values(mod) includes default in some runtimes,
      // so a plain default export would otherwise be installed twice.
      const seen = new Set<unknown>();
      const candidates: unknown[] = [];
      for (const v of mod.default ? [mod.default, ...Object.values(mod)] : Object.values(mod)) {
        if (!seen.has(v)) { seen.add(v); candidates.push(v); }
      }

      for (const candidate of candidates) {
        if (isPlugin(candidate)) {
          candidate.install(bus);
          loaded.push(candidate);
          console.log(`Loaded workspace plugin: ${candidate.name} (${file})`);
        }
      }
    } catch (err) {
      console.error(`Failed to load plugin ${file}:`, err);
    }
  }

  return loaded;
}

const workspacePlugins = await loadWorkspacePlugins();

const allPlugins = [...corePlugins, ...registeredPlugins, ...workspacePlugins];

// ── Wire dormant alert paths → Discord ──────────────────────────────────────
// ops.alert.budget and world.action.queue_full are published but had no consumers.
// Forward both to message.outbound.discord.alert so they surface to operators.

bus.subscribe("ops.alert.budget", "alert-bridge", (msg) => {
  const p = (msg.payload ?? {}) as Record<string, unknown>;
  const text = p.type === "cost_discrepancy"
    ? `Budget alert — cost discrepancy on request \`${p.requestId}\``
    : `Budget alert — ${String(p.type ?? "unknown")}: ${String(p.report ?? "")}`;
  bus.publish("message.outbound.discord.alert", {
    id: crypto.randomUUID(),
    correlationId: msg.correlationId,
    topic: "message.outbound.discord.alert",
    timestamp: Date.now(),
    payload: { text, level: "warn", source: "budget" },
  });
});

bus.subscribe("world.action.queue_full", "alert-bridge", (msg) => {
  const p = (msg.payload ?? {}) as Record<string, unknown>;
  const text = `Action queue full — WIP ${p.wipCount}/${p.wipLimit}, pending: \`${p.pendingActionId}\``;
  bus.publish("message.outbound.discord.alert", {
    id: crypto.randomUUID(),
    correlationId: msg.correlationId,
    topic: "message.outbound.discord.alert",
    timestamp: Date.now(),
    payload: { text, level: "warn", source: "action-dispatcher" },
  });
});

// Outcome analysis alerts — chronic failures and repeated HITL escalations
bus.subscribe("ops.alert.action_quality", "alert-bridge", (msg) => {
  const p = (msg.payload ?? {}) as Record<string, unknown>;
  const rate = typeof p.successRate === "number" ? (p.successRate * 100).toFixed(0) : "?";
  const text = `🔻 Action quality alert — \`${p.actionId}\` success rate ${rate}% (${p.success}/${p.total}). ${p.recommendation ?? ""}`;
  bus.publish("message.outbound.discord.alert", {
    id: crypto.randomUUID(),
    correlationId: msg.correlationId,
    topic: "message.outbound.discord.alert",
    timestamp: Date.now(),
    payload: { text, level: "warn", source: "outcome-analysis" },
  });
});

bus.subscribe("ops.alert.hitl_escalation", "alert-bridge", (msg) => {
  const p = (msg.payload ?? {}) as Record<string, unknown>;
  const text = `🔧 Feature-request signal — \`${p.kind}\` escalated to HITL ${p.count}× for \`${p.target}\`. ${p.recommendation ?? ""}`;
  bus.publish("message.outbound.discord.alert", {
    id: crypto.randomUUID(),
    correlationId: msg.correlationId,
    topic: "message.outbound.discord.alert",
    timestamp: Date.now(),
    payload: { text, level: "warn", source: "outcome-analysis" },
  });
});

console.log("WorkStacean started.");
console.log(`Workspace: ${workspaceDir}`);
console.log(`Plugins: ${allPlugins.map((p) => p.name).join(", ")}`);
console.log(`Topics: ${bus.topics().map((t) => t.pattern).join(", ")}`);
console.log(`Type 'help' for commands.`);

// Show CLI prompt after startup
const cli = corePlugins.find((p) => p.name === "cli") as CLIPlugin;
cli?.showPrompt();

// --- HTTP API server (POST /publish, GET /health, GET /api/*) ---
const HTTP_PORT = parseInt(process.env.WORKSTACEAN_HTTP_PORT || "3000", 10);
const API_KEY = process.env.WORKSTACEAN_API_KEY;

// ── API routes (modular) ──────────────────────────────────────────────────────
import { createAllRoutes, matchPath } from "./api/index.ts";
import type { ApiContext } from "./api/index.ts";

const apiContext: ApiContext = {
  workspaceDir,
  bus,
  plugins: allPlugins,
  executorRegistry,
  telemetry,
  apiKey: API_KEY,
  mailbox: contextMailbox,
  taskTracker,
};

const routes = createAllRoutes(apiContext);

Bun.serve({
  port: HTTP_PORT,
  fetch: async (req) => {
    const { pathname } = new URL(req.url);
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const params = matchPath(route.path, pathname);
      if (params) return route.handler(req, params);
    }
    return Response.json({ success: false, error: "Not found" }, { status: 404 });
  },
});

console.log(`HTTP API listening on port ${HTTP_PORT}`);

// ── Register self-polling world-state domains (after HTTP server is up) ───────
{
  const wsEngine = registeredPlugins.find(p => p.name === "world-state-engine");
  if (wsEngine) {
    const { createHttpCollector } = await import("../lib/plugins/world-state-engine.js");
    type WorldStateEngine = import("../lib/plugins/world-state-engine.js").WorldStateEngine;
    const engine = wsEngine as unknown as WorldStateEngine;
    const base = `http://localhost:${HTTP_PORT}`;

    engine.registerDomain("flow", createHttpCollector(`${base}/api/flow-metrics`), 60_000);
    engine.registerDomain("services", createHttpCollector(`${base}/api/services`), 60_000);
    engine.registerDomain("agent_health", createHttpCollector(`${base}/api/agent-health`), 60_000);
    engine.registerDomain("security", createHttpCollector(`${base}/api/security-summary`), 60_000);
    engine.registerDomain("ci", createHttpCollector(`${base}/api/ci-health`), 300_000); // 5min — GitHub rate limits
    engine.registerDomain("pr_pipeline", createHttpCollector(`${base}/api/pr-pipeline`), 120_000); // 2min
    engine.registerDomain("branch_drift", createHttpCollector(`${base}/api/branch-drift`), 600_000); // 10min
    engine.registerDomain("branch_protection", createHttpCollector(`${base}/api/branch-protection`), 600_000); // 10min — rulesets change rarely
    engine.registerDomain("hitl_queue", createHttpCollector(`${base}/api/hitl-queue`), 30_000); // 30s — catch routing holes fast
    engine.registerDomain("plane", createHttpCollector(`${base}/api/plane-board`), 120_000); // 2min — Plane REST list across projects
    engine.registerDomain("memory", createHttpCollector(`${base}/api/memory-health`), 60_000); // 1min — Graphiti health + search probe

    // agent_fleet_health — bus-aggregated, no HTTP polling needed
    const fleetHealth = registeredPlugins.find(p => p.name === "agent-fleet-health");
    if (fleetHealth) {
      type AgentFleetHealthPlugin = import("./plugins/agent-fleet-health-plugin.js").AgentFleetHealthPlugin;
      engine.registerDomain(
        "agent_fleet_health",
        () => Promise.resolve((fleetHealth as unknown as AgentFleetHealthPlugin).getFleetHealth()),
        60_000,
      );
    }

    console.log("[domain-discovery] Registered local domains: flow, services, agent_health, security, ci, pr_pipeline, branch_drift, branch_protection, hitl_queue, plane, memory, agent_fleet_health");

    // All local + workspace/domains.yaml + per-project domains are now
    // registered. Defer prune briefly so any async per-project domain
    // discovery has a chance to finish before we drop orphans.
    setTimeout(() => engine.pruneOrphanDomains(), 10_000);
  }
}

import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { InMemoryEventBus } from "../lib/bus";
import { DebugPlugin } from "../lib/plugins/debug";
import { LoggerPlugin } from "../lib/plugins/logger";
import { CLIPlugin } from "../lib/plugins/cli";
import { SignalPlugin } from "../lib/plugins/signal";
import { SchedulerPlugin } from "../lib/plugins/scheduler";
import { A2ADeliveryPlugin } from "../lib/plugins/a2a-delivery";
import type { Plugin, } from "../lib/types";
import { parseEnv } from "./config/env.ts";
// Fail-fast env validation — exits immediately on misconfiguration.
parseEnv();

// --- Langfuse OTEL tracer — register BEFORE any plugin that emits spans ---
// Without this, @langfuse/langchain's CallbackHandler (used by
// DeepAgentExecutor) falls through to the no-op OTEL tracer and nothing
// is captured. Gated on LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY.
import { initLangfuseTracer } from "./telemetry/langfuse-tracer.ts";
const langfuseEnabled = initLangfuseTracer();
console.log(`[langfuse] OTEL tracer ${langfuseEnabled ? "registered" : "skipped (no credentials)"}`);
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
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const bus = new InMemoryEventBus();

// --- Context mailbox — mid-execution DM queue for debounced message injection ---
import { ContextMailbox } from "../lib/dm/context-mailbox.ts";
const contextMailbox = new ContextMailbox();

// --- Task tracker — tracks long-running A2A tasks that returned non-terminal state ---
import { TaskTracker } from "./executor/task-tracker.ts";
const taskTracker = new TaskTracker({ bus });

// --- Agent key registry — resolves per-agent X-API-Key headers to identities
//     so ceremony / cron endpoints (and any future per-agent permission gates)
//     can enforce ownership. Falls back to admin-only mode when
//     workspace/agent-keys.yaml is absent.
import { AgentKeyRegistry } from "../lib/auth/agent-keys.ts";
const agentKeys = new AgentKeyRegistry(workspaceDir, process.env.WORKSTACEAN_API_KEY);

// --- A2A extensions — register observability interceptors (cost, confidence,
//     effect-domain, blast, hitl-mode, worldstate-delta). A2AExecutor.execute()
//     runs the before/after hooks on every skill call; the extensions
//     self-gate on the presence of their advertised fields, so registering
//     all of them is safe even when an agent doesn't opt in via its card.
import { registerCostExtension } from "./executor/extensions/cost.ts";
import { registerConfidenceExtension } from "./executor/extensions/confidence.ts";
import { registerEffectDomainExtension } from "./executor/extensions/effect-domain.ts";
import { registerBlastExtension } from "./executor/extensions/blast.ts";
import { registerHitlModeExtension } from "./executor/extensions/hitl-mode.ts";
import { registerLangfuseTraceExtension } from "./executor/extensions/langfuse-trace.ts";
registerCostExtension(bus);
registerConfidenceExtension(bus);
registerEffectDomainExtension(bus);
registerBlastExtension();
registerHitlModeExtension();
registerLangfuseTraceExtension();

// --- ChannelRegistry — loaded from workspace/channels.yaml, shared by RouterPlugin + DiscordPlugin ---
import { ChannelRegistry } from "../lib/channels/channel-registry.js";
const channelRegistry = new ChannelRegistry(join(workspaceDir, "channels.yaml"));
channelRegistry.startWatching();

// --- Telemetry: per-skill counters persisted to knowledge.db ---
// Exposed via /api/telemetry/* endpoints. Skill counters are bumped by
// SkillDispatcherPlugin on every dispatch outcome.
import { TelemetryService } from "./telemetry/telemetry-service.js";
const telemetry = new TelemetryService(`${dataDir}/knowledge.db`);
telemetry.init();

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
  new A2ADeliveryPlugin(workspaceDir),
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
    // Linear webhook receiver + outbound mutations. Gated on either of the
    // two env vars being present — without LINEAR_WEBHOOK_SECRET inbound
    // verification is disabled (dev mode), without LINEAR_API_KEY outbound
    // is disabled. Loading the plugin with neither is pointless, so require
    // at least one to be set before installing.
    name: "linear",
    condition: () =>
      Boolean(process.env.LINEAR_WEBHOOK_SECRET || process.env.LINEAR_API_KEY),
    factory: async () => {
      const { LinearPlugin } = await import("../lib/plugins/linear");
      return new LinearPlugin();
    },
  },
  {
    // Linear → protoMaker board feature bridge. No-op when
    // workspace/linear-board-mappings.yaml is absent or empty, so it's
    // safe to install unconditionally.
    name: "linear-protomaker-bridge",
    condition: () => true,
    factory: async () => {
      const { LinearProtoMakerBridgePlugin } = await import(
        "../lib/plugins/linear-protomaker-bridge"
      );
      return new LinearProtoMakerBridgePlugin(workspaceDir);
    },
  },
  {
    // Google Workspace — Drive / Docs / Calendar / Gmail outbound + polling.
    // Gated on the full OAuth2 credential triple. The plugin's own install()
    // logs and skips wiring when any are missing, so the gate here is mostly
    // about not paying the import cost on a setup that can't authenticate.
    name: "google",
    condition: () =>
      Boolean(
        process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        process.env.GOOGLE_REFRESH_TOKEN,
      ),
    factory: async () => {
      const { GooglePlugin } = await import("../lib/plugins/google");
      return new GooglePlugin(workspaceDir);
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
    name: "event-viewer",
    condition: () => !process.env.DISABLE_EVENT_VIEWER,
    factory: async () => {
      const { EventViewerPlugin } = await import("../lib/plugins/event-viewer");
      return new EventViewerPlugin();
    },
  },
  {
    // Registers DeepAgentExecutors for workspace/agents/*.yaml into ExecutorRegistry.
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
    // Registers Discord-alert FunctionExecutors for `alert.*` skills that
    // have no agent-backed handler. Crons/ceremonies can dispatch alert.*
    // skills directly without needing an agent.
    // Must install AFTER ExecutorRegistry exists (always true) and BEFORE
    // skill-dispatcher so registrations resolve on first dispatch.
    name: "alert-skill-executor",
    condition: () => true,
    factory: async () => {
      const { AlertSkillExecutorPlugin } = await import("./plugins/alert-skill-executor-plugin.js");
      return new AlertSkillExecutorPlugin(executorRegistry);
    },
  },
  {
    // Registers FunctionExecutors that bridge `ceremony.*` skills to the
    // matching `ceremony.<id>.execute` bus trigger CeremonyPlugin listens
    // for, so any skill caller (cron, external trigger, agent) can invoke
    // a ceremony by name.
    // Must install AFTER ExecutorRegistry exists (always true) and BEFORE
    // skill-dispatcher so registrations resolve on first dispatch.
    name: "ceremony-skill-executor",
    condition: () => true,
    factory: async () => {
      const { CeremonySkillExecutorPlugin } = await import("./plugins/ceremony-skill-executor-plugin.js");
      return new CeremonySkillExecutorPlugin(executorRegistry);
    },
  },
  {
    // Registers FunctionExecutors for the `action.pr_*` /
    // `action.dispatch_backmerge` skills whose handlers live in
    // PrRemediatorPlugin.
    // Same install-order constraint as alert-skill-executor: AFTER the
    // ExecutorRegistry exists, BEFORE skill-dispatcher subscribes.
    name: "pr-remediator-skill-executor",
    condition: () => !!(process.env.QUINN_APP_PRIVATE_KEY || process.env.GITHUB_TOKEN),
    factory: async () => {
      const { PrRemediatorSkillExecutorPlugin } = await import("./plugins/pr-remediator-skill-executor-plugin.js");
      return new PrRemediatorSkillExecutorPlugin(executorRegistry);
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
      return new SkillDispatcherPlugin(executorRegistry, workspaceDir, undefined, contextMailbox, taskTracker);
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
    name: "pr-remediator",
    condition: () => !!(process.env.QUINN_APP_PRIVATE_KEY || process.env.GITHUB_TOKEN),
    factory: async () => {
      const { PrRemediatorPlugin } = await import("../lib/plugins/pr-remediator.js");
      return new PrRemediatorPlugin();
    },
  },
  {
    // Aggregates autonomous.outcome.# into per-agent 24h
    // success/latency/cost rollups; exposed as agent_fleet_health domain.
    name: "agent-fleet-health",
    condition: () => true,
    factory: async () => {
      const { AgentFleetHealthPlugin } = await import("./plugins/agent-fleet-health-plugin.js");
      // executorRegistry wired for outcome attribution whitelist (#459).
      return new AgentFleetHealthPlugin(executorRegistry);
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

// ── OperatorRoutingPlugin — abstracts operator messaging across transports ──
// Agents publish `operator.message.request`; this plugin picks channel(s)
// (Discord DM today; SMS/Signal/push future) and dispatches. Pre-installed so
// any other plugin that wants to reach the operator has a stable contract.
const { OperatorRoutingPlugin } = await import("../lib/plugins/operator-routing.js");
const { IdentityRegistry } = await import("../lib/identity/identity-registry.js");
const operatorIdentityRegistry = new IdentityRegistry(workspaceDir);
const operatorRoutingPlugin = new OperatorRoutingPlugin(operatorIdentityRegistry);
operatorRoutingPlugin.install(bus);
registeredPlugins.push(operatorRoutingPlugin);

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
  dataDir,
  bus,
  plugins: allPlugins,
  executorRegistry,
  telemetry,
  apiKey: API_KEY,
  agentKeys,
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

// ── Wire fleet-health into ExecutorRegistry for health-weighted dispatch ──
{
  const fleetHealth = registeredPlugins.find(p => p.name === "agent-fleet-health");
  if (fleetHealth) {
    type AgentFleetHealthPlugin = import("./plugins/agent-fleet-health-plugin.js").AgentFleetHealthPlugin;
    const fleetPlugin = fleetHealth as unknown as AgentFleetHealthPlugin;
    executorRegistry.setHealthGetter(() => fleetPlugin.getFleetHealth().agents);
  }
}

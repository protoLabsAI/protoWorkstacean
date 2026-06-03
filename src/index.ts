import { existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { InMemoryEventBus } from "../lib/bus";
import { DebugPlugin } from "../lib/plugins/debug";
import { LoggerPlugin } from "../lib/plugins/logger";
import { CLIPlugin } from "../lib/plugins/cli";
import { SignalPlugin } from "../lib/plugins/signal";
import { SchedulerPlugin } from "../lib/plugins/scheduler";
import { A2ADeliveryPlugin } from "../lib/plugins/a2a-delivery";
import { ControlPlaneRegistrarPlugin } from "./plugins/control-plane-registrar-plugin.ts";
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

// --- Bus history recorder — in-memory ring buffer that captures every bus
//     message for /api/bus/history (D1 skill-trace view). Installed BEFORE
//     any other plugin so we don't miss early-startup traffic. See
//     src/event-bus/history-recorder.ts for ring + TTL semantics.
import { BusHistoryRecorder, BusHistoryRecorderPlugin } from "./event-bus/history-recorder.ts";
const busHistoryRecorder = new BusHistoryRecorder();
const busHistoryRecorderPlugin = new BusHistoryRecorderPlugin(busHistoryRecorder);
busHistoryRecorderPlugin.install(bus);

// --- Skill-response cache — terminal results by correlationId for /api/a2a/task ---
import { SkillResponseCache, SkillResponseCachePlugin } from "./event-bus/skill-response-cache.ts";
const skillResponseCache = new SkillResponseCache();
const skillResponseCachePlugin = new SkillResponseCachePlugin(skillResponseCache);
skillResponseCachePlugin.install(bus);

// --- Context mailbox — mid-execution DM queue for debounced message injection ---
import { ContextMailbox } from "../lib/dm/context-mailbox.ts";
const contextMailbox = new ContextMailbox();

// --- Task tracker — tracks long-running A2A tasks that returned non-terminal state ---
import { TaskTracker } from "./executor/task-tracker.ts";
const taskTracker = new TaskTracker({ bus });

// Handle to the dispatcher's in-flight check — assigned when its (lazy) factory
// runs below. Read via a closure in apiContext so the poll endpoint can report
// a "working" state for in-process dispatches still executing (not yet in the
// SkillResponseCache and not tracked by TaskTracker — that path only covers A2A).
let skillDispatcher: { isActive(correlationId: string): boolean } | undefined;

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

// --- ProjectRegistry — source of truth for project metadata. Constructed
//     before consumer plugins so they can read from a populated registry on
//     install. We await an initial refresh to avoid the first-N-second window
//     where consumers would see empty project state. If protoMaker is
//     unreachable, the registry stays empty and re-tries every 5 min —
//     consumers degrade gracefully (no project enrichment, empty allowlists).
import { ProjectRegistry } from "./plugins/project-registry.js";
const projectRegistry = new ProjectRegistry();
await projectRegistry.refreshNow();
console.log(
  `[startup] ProjectRegistry: ${projectRegistry.getProjects().length} project(s) loaded` +
    (projectRegistry.getLastError() ? ` (error: ${projectRegistry.getLastError()})` : ""),
);

// --- Telemetry: per-skill counters persisted to knowledge.db ---
// Exposed via /api/telemetry/* endpoints. Skill counters are bumped by
// SkillDispatcherPlugin on every dispatch outcome.
import { TelemetryService } from "./telemetry/telemetry-service.js";
const telemetry = new TelemetryService(`${dataDir}/knowledge.db`);
telemetry.init();

// Durable backing for fleet health — persists outcomes + rehydrates the 24h
// window on restart, so fleet visibility survives redeploys (ADR-0004 P5).
import { FleetStateRepository } from "./knowledge/fleet-state.js";
const fleetStateRepo = new FleetStateRepository(`${dataDir}/knowledge.db`);
fleetStateRepo.init();

// Researcher agent's hybrid knowledge base (sqlite-vec + FTS5). Backs /api/research/*.
import { ResearchStore } from "./knowledge/research-store.ts";
const researchStore = new ResearchStore(`${dataDir}/knowledge.db`);
researchStore.init();

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
  // ADR-0004 P2: sole writer of workspace config for control-plane command.* mutations.
  new ControlPlaneRegistrarPlugin(workspaceDir),
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
      return new RouterPlugin({ workspaceDir, channelRegistry, projectRegistry });
    },
  },
  {
    // FeatureNotifierPlugin posts protoMaker feature.completed/failed events to
    // each project's dev channel (ADR-0002 reporting leg). Shares the router's
    // ChannelRegistry. First-party (not a workspace plugin) so it can resolve
    // app internals in the container — the workspace-plugin version never did.
    name: "feature-notifier",
    condition: () => true,
    factory: async () => {
      const { FeatureNotifierPlugin } = await import("../lib/plugins/feature-notifier");
      return new FeatureNotifierPlugin({ channelRegistry });
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
        projectRegistry,
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
      return new GitHubPlugin(workspaceDir, projectRegistry);
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
    // Recovers Linear agent sessions Linear failed to deliver a webhook for
    // (their delivery is intermittent). Polls for `stale` sessions and re-drives
    // them through the same agent-session pipeline. Safety net for the webhook.
    name: "linear-agent-session-poller",
    condition: () => Boolean(process.env.LINEAR_API_KEY),
    factory: async () => {
      const { LinearAgentSessionPoller } = await import("../lib/plugins/linear-agent-session-poller");
      return new LinearAgentSessionPoller();
    },
  },
  {
    // GitHub issue → protoMaker board bridge. workstacean receives every
    // project repo's webhook + owns the registry, so it resolves the project
    // and POSTs to protoMaker's HTTP board intake (ADR-0001/0002). No-op for
    // issues on unregistered repos. Safe to install unconditionally.
    name: "protomaker-board-bridge",
    condition: () => true,
    factory: async () => {
      const { ProtoMakerBoardBridgePlugin } = await import(
        "../lib/plugins/protomaker-board-bridge"
      );
      return new ProtoMakerBoardBridgePlugin(projectRegistry);
    },
  },
  {
    // Linear → proto code.execute bridge. Label-gated (default
    // "proto-task", override via LINEAR_PROTO_BRIDGE_LABEL). No yaml
    // config needed; safe to install unconditionally.
    name: "linear-proto-bridge",
    condition: () => true,
    factory: async () => {
      const { LinearProtoBridgePlugin } = await import(
        "../lib/plugins/linear-proto-bridge"
      );
      return new LinearProtoBridgePlugin();
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
    // MCP client tier (ADR-0005 P4): connects to enabled MCP servers from
    // workspace/mcp-servers.d/ and registers one McpExecutor per discovered
    // tool. Control-plane-managed (command.mcp.*); hot-reloads with no restart.
    name: "mcp-client",
    condition: () => true,
    factory: async () => {
      const { McpClientPlugin } = await import("./mcp/mcp-client-plugin.js");
      return new McpClientPlugin(workspaceDir, executorRegistry);
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
    // Routes Quinn's REQUEST_CHANGES verdicts to Discord. Subscribes to
    // quinn.review.submitted (published by src/api/pr-inspector.ts after
    // every review_* action) and republishes blocking verdicts as
    // message.outbound.discord.alert so the operator sees them in Discord
    // without refreshing GitHub. APPROVE/COMMENT verdicts are intentionally
    // silent — only blocking signals get pinged.
    name: "quinn-review-notifier",
    condition: () => true,
    factory: async () => {
      const { QuinnReviewNotifierPlugin } = await import("./plugins/quinn-review-notifier-plugin.js");
      return new QuinnReviewNotifierPlugin();
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
    // Registers a FunctionExecutor for `ceremony.clawpatch_cache_cleanup`
    // (workspace/ceremonies/clawpatch-cache-cleanup.yaml). Pure janitor — calls
    // CheckoutCache.prune() directly; no agent involved. Same install-order
    // constraint as alert-skill-executor.
    name: "clawpatch-cache-cleanup-skill-executor",
    condition: () => true,
    factory: async () => {
      const { ClawpatchCacheCleanupSkillExecutorPlugin } = await import(
        "./plugins/clawpatch-cache-cleanup-skill-executor-plugin.js"
      );
      return new ClawpatchCacheCleanupSkillExecutorPlugin(executorRegistry);
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
      const dispatcher = new SkillDispatcherPlugin(executorRegistry, workspaceDir, contextMailbox, taskTracker);
      skillDispatcher = dispatcher;
      return dispatcher;
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
      return new PrRemediatorPlugin({ projectRegistry });
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
      // fleetStateRepo wired for durable persistence + restart hydration (ADR-0004 P5).
      return new AgentFleetHealthPlugin(executorRegistry, fleetStateRepo);
    },
  },
  {
    // Polls fleet-health every minute (via fleet_alerts ceremony) and dispatches
    // alert.* skills when thresholds trip. Re-wires the alert path that was
    // orphaned when the GOAP layer was ripped (#518).
    name: "fleet-alerts-evaluator",
    condition: () => true,
    factory: async () => {
      const { FleetAlertsEvaluatorPlugin } = await import(
        "./plugins/fleet-alerts-evaluator-plugin.js"
      );
      type AgentFleetHealthPlugin =
        import("./plugins/agent-fleet-health-plugin.js").AgentFleetHealthPlugin;
      const fleetHealth = registeredPlugins.find(p => p.name === "agent-fleet-health");
      if (!fleetHealth) {
        throw new Error(
          "[fleet-alerts-evaluator] AgentFleetHealthPlugin must be registered first — check pluginRegistry order",
        );
      }
      return new FleetAlertsEvaluatorPlugin(
        executorRegistry,
        fleetHealth as unknown as AgentFleetHealthPlugin,
      );
    },
  },
  {
    // Watches dispatch.dropped.# (from SkillDispatcher) for storms — N drops
    // on same key in M min. Escalates to operator.message.request (same pipe
    // as #619 pr-remediator stuck-PR escalations). Per-key cooldown prevents
    // DM flood.
    name: "dispatch-drop-escalator",
    condition: () => true,
    factory: async () => {
      const { DispatchDropEscalatorPlugin } = await import(
        "./plugins/dispatch-drop-escalator-plugin.js"
      );
      return new DispatchDropEscalatorPlugin();
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

// ProjectRegistry — a plain shared object (like channelRegistry above), not a
// plugin. The initial fetch already ran (await refreshNow, before consumer
// construction) so consumers see a populated registry from their first read;
// start() only arms the 5-min background refresh.
projectRegistry.start();

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
    p.name === "agent-runtime" || p.name === "skill-broker" || p.name === "mcp-client",
  );
  if (hasDispatcher && !hasRegistrar) {
    console.warn(
      "[startup] skill-dispatcher is installed but no executor registrar (agent-runtime / skill-broker / mcp-client) is active. " +
      "All agent.skill.request messages will be dropped. " +
      "Add workspace/agents/*.yaml, workspace/agents.yaml, or workspace/mcp-servers.d/ to register at least one agent or MCP server.",
    );
  }
}

// The dynamic workspace/plugins/*.ts loader was retired in ADR-0005 (ADR-0004
// P4). It was structurally broken — Node's module cache pins old code so it
// can't safely hot-reload, and the workspace is bind-mounted outside the app's
// module tree so plugins there can't resolve app lib/ or node_modules. Extension
// is now out-of-process (A2A agents + MCP servers, both control-plane-managed
// and hot-swappable) or compiled-in under lib/plugins/. There is no in-process
// hot-loaded-code surface by design.

const allPlugins = [...corePlugins, ...registeredPlugins];

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
  busHistory: busHistoryRecorder,
  skillResponseCache,
  // Lazy in-flight check — true while a dispatch (in-process or A2A) is executing.
  activeDispatchCheck: (correlationId: string) => skillDispatcher?.isActive(correlationId) ?? false,
  projectRegistry,
  channelRegistry,
  researchStore,
};

const routes = createAllRoutes(apiContext);

// WS /api/bus/subscribe?topic=<pattern>[&apiKey=...]
//   External processes can join the in-process event bus over a WebSocket.
//   Each message that matches the pattern is delivered as a JSON frame
//   { topic, correlationId, timestamp, payload }. The pattern supports the
//   same `#` / `*` wildcards as bus.subscribe(). Authenticated by API key
//   when WORKSTACEAN_API_KEY is set (header X-API-Key or ?apiKey= param).
interface BusSubscribeWsData {
  topic: string;
  subscriberId?: string;
}

// ── Dashboard static-asset serving ───────────────────────────────────────────
// The dashboard is a Vite + React single-page app: one `dashboard/dist/index.html`
// shell plus content-hashed assets under `dashboard/dist/assets/`. Serve like a
// minimal static host with an SPA fallback:
//   /                  → dashboard/dist/index.html
//   /assets/x-<hash>.js → dashboard/dist/assets/x-<hash>.js  (cached immutable)
//   /favicon.svg       → dashboard/dist/favicon.svg
//   /system, /agents…  → dashboard/dist/index.html (client route — react-router renders it)
// Returns null when nothing matches (missing asset → the caller's 404).
const DASHBOARD_DIST = resolve(import.meta.dir, "../dashboard/dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff2":"font/woff2",
  ".woff": "font/woff",
  ".map":  "application/json",
  ".txt":  "text/plain; charset=utf-8",
};

async function serveDashboardAsset(pathname: string): Promise<Response | null> {
  // Path traversal guard. Reject anything with `..` segments — Bun.file()
  // resolves symlinks, but normalizing here is cheaper + clearer than
  // discovering an escape after the fact.
  if (pathname.split("/").some(seg => seg === "..")) return null;

  // Strip leading slash; map "" / "/" to the dashboard index.
  const rel = pathname.replace(/^\/+/, "") || "index.html";

  // Exact file hit — assets, favicon, index.html.
  const exact = Bun.file(join(DASHBOARD_DIST, rel));
  if (await exact.exists()) {
    const ext = rel.slice(rel.lastIndexOf("."));
    const type = MIME[ext] ?? "application/octet-stream";
    // Vite emits content-hashed files under /assets/ — safe to cache hard;
    // everything else (the index shell) stays mutable so rebuilds land.
    const cacheControl = pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache";
    return new Response(exact, {
      headers: { "content-type": type, "cache-control": cacheControl },
    });
  }

  // SPA fallback: an extensionless path is a client route (/system, /agents…)
  // — serve the app shell and let react-router render it. A path that looks
  // like a missing asset (has an extension) falls through to null → 404.
  const hasExtension = rel.includes(".") && !rel.endsWith("/");
  if (!hasExtension) {
    const shell = Bun.file(join(DASHBOARD_DIST, "index.html"));
    if (await shell.exists()) {
      return new Response(shell, {
        headers: { "content-type": MIME[".html"], "cache-control": "no-cache" },
      });
    }
  }
  return null;
}

Bun.serve<BusSubscribeWsData>({
  port: HTTP_PORT,
  fetch: async (req, server) => {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/api/bus/subscribe") {
      if (API_KEY) {
        const headerKey = req.headers.get("X-API-Key");
        const queryKey = url.searchParams.get("apiKey");
        const provided = headerKey ?? queryKey;
        if (provided !== API_KEY) {
          return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }
      }
      const topic = url.searchParams.get("topic");
      if (!topic) {
        return Response.json({ success: false, error: "Missing ?topic= query param" }, { status: 400 });
      }
      const upgraded = server.upgrade(req, { data: { topic } });
      if (upgraded) return undefined as unknown as Response;
      return Response.json({ success: false, error: "WebSocket upgrade failed" }, { status: 426 });
    }

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const params = matchPath(route.path, pathname);
      if (params) return route.handler(req, params);
    }

    // Static dashboard fallback. The Astro static build lives at
    // dashboard/dist/ in the container image (baked in by Dockerfile's
    // dashboard-build stage). Without this, /system + /trace + every
    // other dashboard route 404'd despite the assets being present —
    // never wired since #555 shipped the dashboard. GET-only; API
    // routes above always win.
    if (req.method === "GET") {
      const staticResp = await serveDashboardAsset(pathname);
      if (staticResp) return staticResp;
    }

    return Response.json({ success: false, error: "Not found" }, { status: 404 });
  },
  websocket: {
    open(ws) {
      const { topic } = ws.data;
      const subscriberId = bus.subscribe(topic, `ws-${crypto.randomUUID()}`, (msg) => {
        try {
          ws.send(JSON.stringify({
            topic: msg.topic,
            correlationId: msg.correlationId,
            timestamp: msg.timestamp,
            payload: msg.payload,
          }));
        } catch {
          // Client disconnected mid-send; cleanup will happen in close()
        }
      });
      ws.data.subscriberId = subscriberId;
      console.log(`[bus-ws] subscribed to "${topic}" (sub ${subscriberId})`);
    },
    close(ws) {
      const { topic, subscriberId } = ws.data;
      if (subscriberId) bus.unsubscribe(subscriberId);
      console.log(`[bus-ws] unsubscribed from "${topic}"`);
    },
    message() {
      // Read-only: external subscribers receive bus events; to publish,
      // use POST /publish (already authenticated, idempotent).
    },
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

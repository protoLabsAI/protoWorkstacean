import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { InMemoryEventBus } from "../lib/bus";
import { DebugPlugin } from "../lib/plugins/debug";
import { LoggerPlugin } from "../lib/plugins/logger";
import { CLIPlugin } from "../lib/plugins/cli";
import { SignalPlugin } from "../lib/plugins/signal";
import { SchedulerPlugin } from "../lib/plugins/scheduler";
import { ActionRegistry } from "./planner/action-registry";
import type { Plugin, BusMessage } from "../lib/types";
import type { Action } from "./planner/types/action";
import type { SecurityIncident } from "../lib/types/world-state.ts";

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

// Core plugins — always loaded, statically imported (no dynamic overhead needed)
const debugPlugin = new DebugPlugin();
debugPlugin.install(bus);

const corePlugins: Plugin[] = [
  debugPlugin,
  new LoggerPlugin(dataDir),
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

const pluginRegistry: PluginRegistryEntry[] = [
  {
    name: "agent",
    condition: () => !process.env.DISABLE_AGENT_PLUGIN,
    factory: async () => {
      const { AgentPlugin } = await import("../lib/plugins/agent");
      return new AgentPlugin(workspaceDir, dataDir);
    },
  },
  {
    name: "discord",
    condition: () => !!process.env.DISCORD_BOT_TOKEN,
    factory: async () => {
      const { DiscordPlugin } = await import("../lib/plugins/discord");
      return new DiscordPlugin(workspaceDir, dataDir);
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
    // Always register — degrades gracefully without credentials
    condition: () => true,
    factory: async () => {
      const { PlanePlugin } = await import("../lib/plugins/plane");
      return new PlanePlugin(workspaceDir);
    },
  },
  {
    name: "a2a",
    condition: () => true,
    factory: async () => {
      const { A2APlugin } = await import("../lib/plugins/a2a");
      return new A2APlugin(workspaceDir);
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
    name: "hitl",
    condition: () => true,
    factory: async () => {
      const { HITLPlugin } = await import("../lib/plugins/hitl");
      return new HITLPlugin(workspaceDir);
    },
  },
  {
    name: "plane-hitl",
    condition: () => true,
    factory: async () => {
      const { PlaneHITLPlugin } = await import("../lib/plugins/plane-hitl");
      return new PlaneHITLPlugin(workspaceDir);
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
      return new GoalEvaluatorPlugin({ workspaceDir });
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
    // AgentRuntimePlugin handles in-process agents (workspace/agents/*.yaml).
    // SkillBrokerPlugin handles external A2A agents (workspace/agents.yaml).
    // Both can run simultaneously — AgentRuntime short-circuits for agents it
    // owns; unknown agents fall through to SkillBroker.
    name: "agent-runtime",
    condition: () => !process.env.DISABLE_AGENT_RUNTIME,
    factory: async () => {
      const { AgentRuntimePlugin } = await import("./agent-runtime/agent-runtime-plugin.js");
      return new AgentRuntimePlugin({
        workspaceDir,
        apiBaseUrl: `http://localhost:${process.env.WORKSTACEAN_HTTP_PORT ?? "3000"}`,
        apiKey: process.env.WORKSTACEAN_API_KEY,
      });
    },
  },
  {
    name: "skill-broker",
    condition: () => !process.env.DISABLE_SKILL_BROKER,
    factory: async () => {
      const { SkillBrokerPlugin } = await import("./plugins/skill-broker-plugin.js");
      return new SkillBrokerPlugin(workspaceDir);
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
    name: "world-state-collector",
    condition: () => true,
    factory: async () => {
      const { WorldStateCollectorPlugin } = await import("../lib/plugins/world-state-collector.js");
      return new WorldStateCollectorPlugin({ knowledgeDbPath: `${dataDir}/knowledge.db`, workspaceDir });
    },
  },
  {
    name: "action-dispatcher",
    condition: () => true,
    factory: async () => {
      const { ActionDispatcherPlugin } = await import("./plugins/action-dispatcher-plugin.js");
      return new ActionDispatcherPlugin({ wipLimit: 5 });
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
    name: "flow-monitor",
    condition: () => true,
    factory: async () => {
      const { FlowMonitorPlugin } = await import("../lib/plugins/flow-monitor.js");
      return new FlowMonitorPlugin();
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
for (const entry of pluginRegistry) {
  if (entry.condition()) {
    const plugin = await entry.factory();
    plugin.install(bus);
    registeredPlugins.push(plugin);
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

function serveWorkspaceYaml(filename: string, key: string): Response {
  const filePath = join(workspaceDir, filename);
  if (!existsSync(filePath)) return Response.json({ success: true, data: [] });
  try {
    const parsed = parseYaml(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return Response.json({ success: true, data: parsed[key] ?? [] });
  } catch {
    return Response.json({ success: false, error: `Failed to parse ${filename}` }, { status: 500 });
  }
}

async function handlePublish(req: Request): Promise<Response> {
  if (API_KEY && req.headers.get("X-API-Key") !== API_KEY) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.topic || typeof body.topic !== "string") {
    return Response.json(
      { success: false, error: "Missing or invalid 'topic' (must be a string)" },
      { status: 400 }
    );
  }

  const message: BusMessage = {
    id: crypto.randomUUID(),
    correlationId: typeof body.correlationId === "string" ? body.correlationId : crypto.randomUUID(),
    topic: body.topic,
    timestamp: Date.now(),
    payload: body.payload,
    ...(body.source ? { source: body.source as BusMessage["source"] } : {}),
    ...(body.reply ? { reply: body.reply as BusMessage["reply"] } : {}),
  };

  bus.publish(body.topic, message);
  return Response.json({ success: true, id: message.id });
}

async function handleOnboard(req: Request): Promise<Response> {
  if (API_KEY && req.headers.get("X-API-Key") !== API_KEY) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.slug || !body.title || !body.github) {
    return Response.json(
      { success: false, error: "Missing required fields: slug, title, github (owner/repo)" },
      { status: 400 },
    );
  }

  const correlationId = crypto.randomUUID();
  const topic = "message.inbound.onboard";

  // Wait up to 30s for the pipeline to complete and reply
  const result = await new Promise<Record<string, unknown>>((resolve) => {
    const replyTopic = `onboard.result.${correlationId}`;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const subId = bus.subscribe(replyTopic, "onboard-http", (msg: BusMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bus.unsubscribe(subId);
      resolve(msg.payload as Record<string, unknown>);
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      bus.unsubscribe(subId);
      resolve({ success: true, status: "accepted", correlationId, message: "Onboarding started (no response within 30s)" });
    }, 30_000);

    bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId,
      topic,
      timestamp: Date.now(),
      payload: body,
      source: { interface: "api" as const },
      reply: { topic: replyTopic },
    });
  });

  const statusCode = result.success ? 200 : 422;
  return Response.json(result, { status: statusCode });
}

// ── World-state API helpers ────────────────────────────────────────────────────

// Minimal interface so we can call getWorldState() without importing the full type
interface WorldStateAPI {
  getWorldState(opts?: { domain?: string; maxAgeMs?: number }): unknown;
}

// Resolved after plugins are loaded
const worldStateCollector = registeredPlugins.find(p => p.name === "world-state-collector") as (WorldStateAPI & { name: string }) | undefined;

function handleGetWorldState(domain?: string): Response {
  if (!worldStateCollector) {
    return Response.json({ success: false, error: "world-state-collector not available" }, { status: 503 });
  }
  const data = worldStateCollector.getWorldState(domain ? { domain, maxAgeMs: 120_000 } : { maxAgeMs: 120_000 });
  return Response.json({ success: true, data });
}

function handleGetCeremonies(): Response {
  const ceremoniesDir = join(workspaceDir, "ceremonies");
  if (!existsSync(ceremoniesDir)) return Response.json({ success: true, data: [] });
  const files = readdirSync(ceremoniesDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  const ceremonies: unknown[] = [];
  for (const file of files) {
    try {
      const parsed = parseYaml(readFileSync(join(ceremoniesDir, file), "utf8")) as Record<string, unknown>;
      ceremonies.push(parsed);
    } catch { /* skip malformed files */ }
  }
  return Response.json({ success: true, data: ceremonies });
}

async function handleRunCeremony(req: Request, ceremonyId: string): Promise<Response> {
  if (API_KEY && req.headers.get("X-API-Key") !== API_KEY) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  // Sanitize ceremonyId — only allow alphanumeric, dash, dot, underscore
  if (!/^[\w.\-]+$/.test(ceremonyId)) {
    return Response.json({ success: false, error: "Invalid ceremony id" }, { status: 400 });
  }
  const topic = `ceremony.${ceremonyId}.execute`;
  bus.publish(topic, {
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    topic,
    timestamp: Date.now(),
    payload: { type: "manual.execute", triggeredBy: "api" },
  });
  return Response.json({ success: true, message: `Ceremony "${ceremonyId}" triggered` });
}

// ── Incidents API ─────────────────────────────────────────────────────────────

function handleGetIncidents(): Response {
  return serveWorkspaceYaml("incidents.yaml", "incidents");
}

async function handleReportIncident(req: Request): Promise<Response> {
  if (API_KEY && req.headers.get("X-API-Key") !== API_KEY) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.title || !body.severity) {
    return Response.json(
      { success: false, error: "Missing required fields: title, severity" },
      { status: 400 }
    );
  }

  const incidentsPath = join(workspaceDir, "incidents.yaml");
  let existing: SecurityIncident[] = [];
  if (existsSync(incidentsPath)) {
    try {
      const parsed = parseYaml(readFileSync(incidentsPath, "utf8")) as { incidents?: SecurityIncident[] };
      existing = parsed.incidents ?? [];
    } catch { /* start fresh */ }
  }

  const incident: SecurityIncident = {
    id: `INC-${String(existing.length + 1).padStart(3, "0")}`,
    title: body.title as string,
    severity: body.severity as SecurityIncident["severity"],
    status: (body.status as SecurityIncident["status"]) ?? "open",
    reportedAt: new Date().toISOString(),
    ...(body.description ? { description: body.description as string } : {}),
    ...(Array.isArray(body.affectedProjects) ? { affectedProjects: body.affectedProjects as string[] } : {}),
    ...(body.assignee ? { assignee: body.assignee as string } : {}),
  };

  existing.push(incident);
  writeFileSync(incidentsPath, stringifyYaml({ incidents: existing }), "utf8");

  // Notify bus — world-state-collector re-collects security domain immediately
  bus.publish("security.incident.reported", {
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    topic: "security.incident.reported",
    timestamp: Date.now(),
    payload: { incident },
  });

  return Response.json({ success: true, data: incident }, { status: 201 });
}

async function handleResolveIncident(req: Request, incidentId: string): Promise<Response> {
  if (API_KEY && req.headers.get("X-API-Key") !== API_KEY) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const incidentsPath = join(workspaceDir, "incidents.yaml");
  if (!existsSync(incidentsPath)) {
    return Response.json({ success: false, error: "No incidents file found" }, { status: 404 });
  }

  let incidents: SecurityIncident[];
  try {
    const parsed = parseYaml(readFileSync(incidentsPath, "utf8")) as { incidents?: SecurityIncident[] };
    incidents = parsed.incidents ?? [];
  } catch {
    return Response.json({ success: false, error: "Failed to parse incidents.yaml" }, { status: 500 });
  }

  const idx = incidents.findIndex(i => i.id === incidentId);
  if (idx === -1) {
    return Response.json({ success: false, error: `Incident "${incidentId}" not found` }, { status: 404 });
  }

  incidents[idx] = { ...incidents[idx], status: "resolved" };
  writeFileSync(incidentsPath, stringifyYaml({ incidents }), "utf8");

  bus.publish("security.incident.reported", {
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    topic: "security.incident.reported",
    timestamp: Date.now(),
    payload: { incident: incidents[idx] },
  });

  return Response.json({ success: true, data: incidents[idx] });
}

function handleGetAgentSkills(agentName: string): Response {
  const agentsPath = join(workspaceDir, "agents.yaml");
  if (!existsSync(agentsPath)) {
    return Response.json({ success: false, error: "agents.yaml not found" }, { status: 404 });
  }
  try {
    const parsed = parseYaml(readFileSync(agentsPath, "utf8")) as {
      agents?: Array<{ name: string; skills?: unknown[] }>;
    };
    const agent = (parsed.agents ?? []).find(a => a.name === agentName);
    if (!agent) {
      return Response.json({ success: false, error: `Agent "${agentName}" not found` }, { status: 404 });
    }
    return Response.json({ success: true, data: { name: agent.name, skills: agent.skills ?? [] } });
  } catch {
    return Response.json({ success: false, error: "Failed to parse agents.yaml" }, { status: 500 });
  }
}

// ── HTTP router ───────────────────────────────────────────────────────────────

type Params = Record<string, string>;
type RouteHandler = (req: Request, params: Params) => Response | Promise<Response>;

/** Match a path against a pattern like "/api/foo/:id/run". Returns params or null. */
function matchPath(pattern: string, path: string): Params | null {
  const pp = pattern.split("/");
  const sp = path.split("/");
  if (pp.length !== sp.length) return null;
  const params: Params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) {
      params[pp[i].slice(1)] = sp[i];
    } else if (pp[i] !== sp[i]) {
      return null;
    }
  }
  return params;
}

const routes: Array<{ method: string; path: string; handler: RouteHandler }> = [
  { method: "GET",  path: "/health",                    handler: () => Response.json({ status: "ok", timestamp: Date.now() }) },
  { method: "POST", path: "/publish",                   handler: handlePublish },
  { method: "POST", path: "/api/onboard",               handler: handleOnboard },
  { method: "GET",  path: "/api/projects",              handler: () => serveWorkspaceYaml("projects.yaml", "projects") },
  { method: "GET",  path: "/api/agents",                handler: () => serveWorkspaceYaml("agents.yaml", "agents") },
  { method: "GET",  path: "/api/goals",                 handler: () => serveWorkspaceYaml("goals.yaml", "goals") },
  { method: "GET",  path: "/api/world-state",           handler: () => handleGetWorldState() },
  { method: "GET",  path: "/api/world-state/:domain",   handler: (_, p) => handleGetWorldState(p.domain) },
  { method: "GET",  path: "/api/ceremonies",            handler: () => handleGetCeremonies() },
  { method: "POST", path: "/api/ceremonies/:id/run",    handler: (req, p) => handleRunCeremony(req, p.id) },
  { method: "GET",  path: "/api/skills/:agentName",     handler: (_, p) => handleGetAgentSkills(p.agentName) },
  { method: "GET",  path: "/api/incidents",            handler: () => handleGetIncidents() },
  { method: "POST", path: "/api/incidents",            handler: (req) => handleReportIncident(req) },
  { method: "POST", path: "/api/incidents/:id/resolve", handler: (req, p) => handleResolveIncident(req, p.id) },
];

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

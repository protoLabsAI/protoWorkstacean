import { existsSync, readdirSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { InMemoryEventBus } from "../lib/bus";
import { DebugPlugin } from "../lib/plugins/debug";
import { LoggerPlugin } from "../lib/plugins/logger";
import { CLIPlugin } from "../lib/plugins/cli";
import { SignalPlugin } from "../lib/plugins/signal";
import { SchedulerPlugin } from "../lib/plugins/scheduler";
import type { Plugin, BusMessage } from "../lib/types";

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
      return new DiscordPlugin(workspaceDir);
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
    name: "hitl",
    condition: () => true,
    factory: async () => {
      const { HITLPlugin } = await import("../lib/plugins/hitl");
      return new HITLPlugin(workspaceDir);
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

Bun.serve({
  port: HTTP_PORT,
  fetch: async (req) => {
    const url = new URL(req.url);

    // --- GET /health ---
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", timestamp: Date.now() });
    }

    // --- POST /publish ---
    if (req.method === "POST" && url.pathname === "/publish") {
      // Auth check: if WORKSTACEAN_API_KEY is set, require X-API-Key header
      if (API_KEY) {
        const provided = req.headers.get("X-API-Key");
        if (provided !== API_KEY) {
          return Response.json(
            { success: false, error: "Unauthorized" },
            { status: 401 }
          );
        }
      }

      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { success: false, error: "Invalid JSON body" },
          { status: 400 }
        );
      }

      // Validate topic
      if (!body.topic || typeof body.topic !== "string") {
        return Response.json(
          { success: false, error: "Missing or invalid 'topic' (must be a string)" },
          { status: 400 }
        );
      }

      // Build BusMessage
      const message: BusMessage = {
        id: crypto.randomUUID(),
        correlationId:
          typeof body.correlationId === "string"
            ? body.correlationId
            : crypto.randomUUID(),
        topic: body.topic,
        timestamp: Date.now(),
        payload: body.payload,
        ...(body.source ? { source: body.source as BusMessage["source"] } : {}),
        ...(body.reply ? { reply: body.reply as BusMessage["reply"] } : {}),
      };

      bus.publish(body.topic, message);

      return Response.json({ success: true, id: message.id });
    }

    // --- GET /api/projects ---
    if (req.method === "GET" && url.pathname === "/api/projects") {
      try {
        const projectsPath = join(workspaceDir, "projects.yaml");
        if (!existsSync(projectsPath)) {
          return Response.json({ success: true, data: [] });
        }
        const raw = readFileSync(projectsPath, "utf8");
        const parsed = parseYaml(raw) as { projects?: unknown[] };
        return Response.json({ success: true, data: parsed.projects ?? [] });
      } catch (err) {
        return Response.json(
          { success: false, error: `Failed to parse projects.yaml: ${err}` },
          { status: 500 }
        );
      }
    }

    // --- GET /api/agents ---
    if (req.method === "GET" && url.pathname === "/api/agents") {
      try {
        const agentsPath = join(workspaceDir, "agents.yaml");
        if (!existsSync(agentsPath)) {
          return Response.json({ success: true, data: [] });
        }
        const raw = readFileSync(agentsPath, "utf8");
        const parsed = parseYaml(raw) as { agents?: unknown[] };
        return Response.json({ success: true, data: parsed.agents ?? [] });
      } catch (err) {
        return Response.json(
          { success: false, error: `Failed to parse agents.yaml: ${err}` },
          { status: 500 }
        );
      }
    }

    // --- Fallback ---
    return Response.json(
      { success: false, error: "Not found" },
      { status: 404 }
    );
  },
});

console.log(`HTTP API listening on port ${HTTP_PORT}`);

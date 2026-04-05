import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { InMemoryEventBus } from "../lib/bus";
import { DebugPlugin } from "../lib/plugins/debug";
import { LoggerPlugin } from "../lib/plugins/logger";
import { CLIPlugin } from "../lib/plugins/cli";
import { SignalPlugin } from "../lib/plugins/signal";
import { DiscordPlugin } from "../lib/plugins/discord";
import { GitHubPlugin } from "../lib/plugins/github";
import { EchoPlugin } from "../lib/plugins/echo";
import { AgentPlugin } from "../lib/plugins/agent";
import { A2APlugin } from "../lib/plugins/a2a";
import { SchedulerPlugin } from "../lib/plugins/scheduler";
import { EventViewerPlugin } from "../lib/plugins/event-viewer";
import type { Plugin } from "../lib/types";

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

// Core plugins (always loaded)
// Debug plugin first so it captures all subsequent console output
const debugPlugin = new DebugPlugin();
debugPlugin.install(bus);

const corePlugins: Plugin[] = [
  debugPlugin,
  new LoggerPlugin(dataDir),
  new CLIPlugin(),
  new SignalPlugin(),
  new SchedulerPlugin(dataDir),
];

// AgentPlugin (Pi SDK) — disabled when A2APlugin workspace plugin is active
if (!process.env.DISABLE_AGENT_PLUGIN) {
  corePlugins.push(new AgentPlugin(workspaceDir, dataDir));
}

// DiscordPlugin — enabled when DISCORD_BOT_TOKEN is set
if (process.env.DISCORD_BOT_TOKEN) {
  corePlugins.push(new DiscordPlugin(workspaceDir));
}

// GitHubPlugin — enabled when GITHUB_TOKEN is set
if (process.env.GITHUB_TOKEN) {
  corePlugins.push(new GitHubPlugin(workspaceDir));
}

// A2APlugin — always enabled; loads projects.yaml (no-op if file absent)
corePlugins.push(new A2APlugin(workspaceDir));

if (!process.env.DISABLE_EVENT_VIEWER) {
  corePlugins.push(new EventViewerPlugin());
}

// Built-in plugins (disabled by default, can be enabled via env)
const builtInPlugins: Record<string, Plugin> = {
  echo: new EchoPlugin(),
};

// Install core plugins
for (const plugin of corePlugins) {
  plugin.install(bus);
}

// Install enabled built-in plugins
const enabledPlugins = process.env.ENABLED_PLUGINS?.split(",") || [];
for (const name of enabledPlugins) {
  const plugin = builtInPlugins[name.trim()];
  if (plugin) {
    plugin.install(bus);
    console.log(`Enabled built-in plugin: ${name}`);
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

const allPlugins = [
  ...corePlugins,
  ...enabledPlugins.map((n) => builtInPlugins[n]).filter(Boolean),
  ...workspacePlugins,
];

console.log("WorkStacean started.");
console.log(`Workspace: ${workspaceDir}`);
console.log(`Plugins: ${allPlugins.map((p) => p.name).join(", ")}`);
console.log(`Topics: ${bus.topics().map((t) => t.pattern).join(", ")}`);
console.log(`Type 'help' for commands.`);

// Show CLI prompt after startup
const cli = corePlugins.find((p) => p.name === "cli") as CLIPlugin;
cli?.showPrompt();
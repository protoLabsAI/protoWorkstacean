import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { InMemoryEventBus } from "../lib/bus";
import { LoggerPlugin } from "../lib/plugins/logger";
import { CLIPlugin } from "../lib/plugins/cli";
import { SignalPlugin } from "../lib/plugins/signal";
import { EchoPlugin } from "../lib/plugins/echo";
import { AgentPlugin } from "../lib/plugins/agent";
import { SchedulerPlugin } from "../lib/plugins/scheduler";
import type { Plugin } from "../lib/types";

// --- Workspace config ---
const workspaceDir = resolve(
  process.env.WORKSPACE_DIR || join(process.cwd(), "workspace")
);
if (!existsSync(workspaceDir)) {
  mkdirSync(workspaceDir, { recursive: true });
}

const bus = new InMemoryEventBus();

// Core plugins (always loaded)
const corePlugins: Plugin[] = [
  new LoggerPlugin(),
  new CLIPlugin(),
  new SignalPlugin(),
  new AgentPlugin(workspaceDir),
  new SchedulerPlugin(workspaceDir),
];

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
      // Check default export or named exports for Plugin interface
      const candidates: unknown[] = mod.default
        ? [mod.default, ...Object.values(mod)]
        : Object.values(mod);

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
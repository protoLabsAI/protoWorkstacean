import { InMemoryEventBus } from "../lib/bus";
import { LoggerPlugin } from "../lib/plugins/logger";
import { CLIPlugin } from "../lib/plugins/cli";
import { SignalPlugin } from "../lib/plugins/signal";
import { EchoPlugin } from "../lib/plugins/echo";
import { AgentPlugin } from "../lib/plugins/agent";
import type { Plugin } from "../lib/types";

const bus = new InMemoryEventBus();

// Core plugins (always loaded)
const corePlugins: Plugin[] = [
  new LoggerPlugin(),
  new CLIPlugin(),
  new SignalPlugin(),
  new AgentPlugin(),
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

const allPlugins = [...corePlugins, ...enabledPlugins.map(n => builtInPlugins[n]).filter(Boolean)];

console.log("WorkStacean started.");
console.log(`Plugins: ${allPlugins.map(p => p.name).join(", ")}`);
console.log(`Topics: ${bus.topics().map(t => t.pattern).join(", ")}`);
console.log(`Type 'help' for commands.`);
---
title: Plugin Lifecycle — How Plugins Register, Subscribe, and Reload
---

_This is an explanation doc. It explains how the plugin system works conceptually, not how to write a specific plugin._

---

## Bus plugins

> **Retired surface:** the dynamic `workspace/plugins/*.ts` loader was removed in [ADR-0005](../decisions/0005-mcp-client-tier-and-trust-tiers) (ADR-0004 P4) — Node's module cache made hot-reload unsafe and bind-mounted workspace files couldn't resolve app modules. First-party plugins are now **statically imported and compiled into the image**; runtime extension is out-of-process via A2A agents / MCP servers (see [plugin-system](plugin-system)).

### Startup loading

On container start, `src/index.ts` builds the plugin list from a static registry:

1. Core plugins (Logger, Debug, …) install first
2. Conditionally-enabled integration + registrar plugins (Discord, GitHub, AgentRuntime, SkillBroker, McpClient, …) install if their config is present
3. Each plugin's `install(bus)` is called as it's added

Registrars install before `SkillDispatcherPlugin` first processes a message; otherwise plugins should not depend on each other's install order.

### What happens in `install()`

`install(bus)` is where a plugin wires itself to the bus:

```typescript
install(bus: EventBus): void {
  // Subscribe to inbound messages
  bus.subscribe("message.inbound.discord.#", this.name, this.handleInbound.bind(this));

  // Start HTTP server for webhooks
  this.server = Bun.serve({
    port: 8082,
    fetch: this.handleWebhook.bind(this),
  });
}
```

After `install()` returns, the plugin is live. It receives messages and can publish responses.

### Graceful shutdown

On `SIGTERM` or `SIGINT`, `src/index.ts` calls `plugin.uninstall()` on each installed plugin in reverse order. Plugins should close HTTP servers, cancel timers, and release any resources here.

```typescript
uninstall(): void {
  this.server?.stop();
  clearInterval(this.pollInterval);
}
```

### Hot reload is not supported

There is no hot-reload for workspace bus plugins. To pick up a new or modified plugin:

```bash
docker restart workstacean
```

The restart is fast (seconds) and is the intended workflow for plugin development.

---

## SchedulerPlugin lifecycle

The SchedulerPlugin has its own internal lifecycle for timers:

1. On `install()`, it scans `data/crons/` for YAML files and creates Node.js timers for each enabled schedule
2. On `command.schedule` action `add` — creates a timer immediately and writes the YAML file
3. On `command.schedule` action `remove` — cancels the timer and deletes the YAML file
4. On `command.schedule` action `pause/resume` — cancels/recreates the timer; updates `enabled` in the YAML
5. On `uninstall()` — cancels all active timers

**Missed fire recovery**: On startup, after loading all schedules, the plugin checks each `lastFired` timestamp. If a schedule was due between `lastFired` and now:
- Missed by ≤ 24 hours → fires immediately once
- Missed by > 24 hours → skipped; next regular fire applies

---

## Plugin failure modes

If a conditionally-enabled plugin's `install()` throws, the error is caught and logged; that plugin is not installed but the server continues. A misconfigured integration therefore never prevents startup — you can always connect and debug.

Out-of-process extensions degrade the same way: an unreachable A2A agent or MCP server registers no skills/tools (logged loudly) without affecting the rest of the fleet.

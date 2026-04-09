---
title: Plugin Lifecycle — How Plugins Register, Subscribe, and Reload
---

_This is an explanation doc. It explains how the plugin system works conceptually, not how to write a specific plugin._

---

## Workspace bus plugins

### Startup loading

On container start, `src/index.ts` runs `loadWorkspacePlugins()`:

1. Scans `workspace/plugins/` for `.ts` and `.js` files
2. Dynamically imports each file via `await import(filePath)`
3. Checks that the default export satisfies the `Plugin` interface (`name`, `install`, `uninstall`)
4. Calls `plugin.install(bus)` on each valid plugin

The install order is non-deterministic (filesystem scan order). Plugins should not depend on each other's install order.

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

## Plugin discovery failure modes

If a workspace plugin file fails to import (syntax error, missing dependency), `loadWorkspacePlugins()` logs the error and skips that plugin. Other plugins continue to load. The server starts regardless.

If a plugin's `install()` throws, the error is caught and logged. The plugin is not installed, but the server continues.

This means a broken plugin in `workspace/plugins/` never prevents the server from starting — you can always connect and debug.

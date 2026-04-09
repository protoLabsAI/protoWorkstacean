---
title: Plugin Lifecycle — How Plugins Register, Subscribe, and Reload
---

# Plugin Lifecycle — How Plugins Register, Subscribe, and Reload

_This is an explanation doc. It explains how the plugin system works conceptually, not how to write a specific plugin._

---

## Two plugin systems, one codebase

protoWorkstacean has two distinct plugin systems that serve different purposes:

1. **Workspace bus plugins** (`workspace/plugins/`) — extend the message bus; restart-based
2. **Pi SDK extensions** (`.pi/extensions/`) — extend the LLM tool set; runtime, no restart

They operate independently. An agent can use both simultaneously.

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

## Pi SDK extensions

### Runtime registration

Pi SDK extensions load via the Pi SDK's extension discovery mechanism. They can register tools, commands, and shortcuts at runtime — no container restart required.

```typescript
// .pi/extensions/my-tool.ts
pi.registerTool({
  name: "my-tool",
  // ...
  async execute(toolCallId, params) {
    return { content: [{ type: "text", text: "done" }] };
  },
});
```

After `pi.registerTool()` returns, the tool is immediately callable by the LLM in the current session.

### Discovery locations

| Path | Scope |
|------|-------|
| `~/.pi/agent/extensions/*.ts` | Global — loaded for all projects |
| `.pi/extensions/*.ts` | Project-local — loaded only in this project |

Extensions in `.pi/extensions/` are tied to the project directory. When the agent starts in the protoWorkstacean workspace, all extensions in this directory are loaded.

### Extension lifecycle events

Extensions can subscribe to lifecycle events:

- `session_start` — fires when an agent session begins
- `session_end` — fires when a session ends
- `tool_call` — fires before each tool call (can intercept/block)
- `agent_turn` — fires after each agent response

These enable patterns like injecting context at session start, logging tool calls, or implementing dynamic tool enable/disable based on project state.

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

## Why plugins need restart but extensions don't

Workspace bus plugins use Node.js dynamic imports (`import()`). The Node module loader caches imports. Replacing a cached module requires restarting the process — there is no safe way to hot-reload a module in a running Node/Bun process without risking stale closure references.

Pi SDK extensions bypass this by using the Pi SDK's own extension runtime, which has first-class support for dynamic tool registration via `pi.registerTool()`. The Pi SDK is designed for interactive use where adding tools at runtime is a core feature.

The two systems are complementary: use Pi SDK extensions when you need immediate availability without restart; use workspace plugins when you need to bridge external services at the transport layer (HTTP servers, gateway connections, polling loops).

---

## Plugin discovery failure modes

If a workspace plugin file fails to import (syntax error, missing dependency), `loadWorkspacePlugins()` logs the error and skips that plugin. Other plugins continue to load. The server starts regardless.

If a plugin's `install()` throws, the error is caught and logged. The plugin is not installed, but the server continues.

This means a broken plugin in `workspace/plugins/` never prevents the server from starting — you can always connect and debug.

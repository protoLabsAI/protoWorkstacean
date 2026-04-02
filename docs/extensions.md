# Agent Extensions & Tool Registration

How the agent gains new capabilities, and the two mechanisms available.

## Pi SDK Extensions (Runtime, No Restart)

The Pi SDK supports **dynamic tool registration at runtime** via `pi.registerTool()`. Tools are immediately available to the LLM without restarting the session or container.

```ts
// Inside an extension loaded by the Pi SDK
pi.registerTool({
  name: "deploy",
  label: "Deploy",
  description: "Deploy the application to an environment",
  parameters: Type.Object({
    env: StringEnum(["dev", "staging", "prod"]),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // ...
    return { content: [{ type: "text", text: "Deployed" }], details: {} };
  },
});
```

Key facts from Pi SDK docs:

- `pi.registerTool()` works both during extension load and after startup
- Can be called inside `session_start`, command handlers, or other event handlers
- New tools are refreshed immediately — callable by the LLM without `/reload`
- `pi.setActiveTools()` enables/disables tools at runtime
- `pi.getAllTools()` lists all registered tools with source info

### Extension Discovery Locations

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` | Global (all projects) |
| `.pi/extensions/*.ts` | Project-local |

Our `WORKSPACE_DIR` is separate from the Pi SDK extension paths. To bridge the two, the agent can write extensions to `.pi/extensions/` or the global path.

### What Extensions Can Do

- Register custom tools (`pi.registerTool()`)
- Register slash commands (`pi.registerCommand()`)
- Register keyboard shortcuts (`pi.registerShortcut()`)
- Subscribe to lifecycle events (tool calls, session start/end, agent turns)
- Intercept/block tool calls before execution
- Inject context or modify system prompts
- Build custom TUI components

See [Pi SDK extensions docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) for full API.

## Workspace Plugins (Restart-Based)

Our bus-based plugin system in `workspace/plugins/` is a simpler mechanism for extending the message bus, not the LLM tool set.

### How It Works

1. Agent writes a `.ts` or `.js` file in `workspace/plugins/`
2. File must export an object implementing the `Plugin` interface
3. On container restart, `src/index.ts` scans the directory and dynamically imports each file
4. Valid plugins are installed on the bus via `plugin.install(bus)`

```ts
// workspace/plugins/my-plugin.ts
import type { Plugin, EventBus, BusMessage } from "../../lib/types";

export default {
  name: "my-plugin",
  description: "Does something useful on the bus",
  capabilities: ["custom"],

  install(bus: EventBus) {
    bus.subscribe("message.inbound.#", "my-plugin", (msg: BusMessage) => {
      // React to inbound messages
      bus.publish("message.outbound.custom.#", {
        id: msg.id,
        topic: "message.outbound.custom.#",
        timestamp: Date.now(),
        payload: { content: "Custom response" },
        reply: "Custom response",
      });
    });
  },

  uninstall() {},
} satisfies Plugin;
```

### Restart Flow

1. Agent writes plugin to `workspace/plugins/`
2. Agent or user restarts the container (or publishes `command.restart` if wired up)
3. On startup, `loadWorkspacePlugins()` in `src/index.ts` imports and installs all plugins

### What Bus Plugins Can Do

- Subscribe to any bus topic (`#`, `message.inbound.#`, `command.#`, etc.)
- Publish messages to any topic
- Bridge external services (APIs, webhooks, databases)
- Transform or route messages between channels
- Implement custom command handlers

### What Bus Plugins Cannot Do

- Register tools the LLM can call (that's Pi SDK extension territory)
- Modify the agent's system prompt or context
- Intercept tool calls

## When to Use Which

| Goal | Use |
|------|-----|
| Add an LLM-callable tool | Pi SDK extension |
| Add a slash command | Pi SDK extension |
| React to bus messages | Workspace plugin |
| Bridge an external service | Workspace plugin |
| Intercept/block tool calls | Pi SDK extension |
| Route messages between channels | Workspace plugin |
| Add runtime capabilities without restart | Pi SDK extension |

## Combining Both

The agent can use both systems. Example workflow:

1. Agent receives a Signal message asking to integrate with a new API
2. Agent writes a Pi SDK extension to `.pi/extensions/api-integration.ts` — registers a new tool the LLM can call
3. Agent writes a bus plugin to `workspace/plugins/api-bridge.ts` — subscribes to bus topics to forward messages to the API
4. On restart, both are loaded

Or for no-restart: the agent uses `pi.registerTool()` at runtime to add the LLM tool immediately, and the bus plugin is picked up on next restart.

## MCP Support

Pi SDK **does not ship MCP support**. From the docs:

> **No MCP.** Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support.

MCP bridges are possible via extensions but not built-in. If MCP integration is needed, write a Pi SDK extension that connects to MCP servers and registers their tools via `pi.registerTool()`.

## References

- [Pi SDK Extensions Docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi SDK Docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)
- [Dynamic Tools Example](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/dynamic-tools.ts)

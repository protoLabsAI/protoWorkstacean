---
title: Plugin API Reference
---

_This is a reference doc. It covers the Plugin interface contract and the two extension mechanisms available._

---

See also: [`explanation/plugin-lifecycle.md`](../explanation/plugin-lifecycle.md) for how plugins register, subscribe, and hot-reload.

---

## Plugin interface

All workspace bus plugins must implement:

```typescript
interface Plugin {
  readonly name: string;
  readonly description: string;
  readonly capabilities: string[];
  install(bus: EventBus): void;
  uninstall(): void;
}
```

### `install(bus: EventBus)`

Called once on container startup after the bus is created. Subscribe to topics and set up HTTP servers here.

```typescript
install(bus: EventBus): void {
  bus.subscribe("message.inbound.#", this.name, (msg: BusMessage) => {
    // handle message
  });
}
```

### `uninstall()`

Called on graceful shutdown. Clean up timers, close HTTP servers, release resources.

---

## EventBus interface

```typescript
interface EventBus {
  subscribe(topic: string, subscriberId: string, handler: (msg: BusMessage) => void): void;
  publish(topic: string, message: BusMessage): void;
  unsubscribe(subscriberId: string): void;
}
```

Topic patterns use `#` as a wildcard matching any number of segments (MQTT-style):

```
message.inbound.#          matches message.inbound.github.owner.repo.event.123
message.inbound.discord.#  matches message.inbound.discord.channelId
```

---

## BusMessage shape

```typescript
interface BusMessage {
  id: string;               // UUID
  topic: string;            // the topic this message was published on
  timestamp: number;        // Unix milliseconds
  correlationId?: string;   // links request → response → chain
  payload: {
    sender?: string;
    content?: string;
    channel?: string;
    skillHint?: string;
    reply?: string;
    [key: string]: unknown;
  };
  reply?: string;           // outbound topic for responses
  source?: {
    interface: string;      // "discord" | "github" | "plane" | "cron" | ...
    channelId: string;
    userId: string;
  };
}
```

---

## Pi SDK Extensions (Runtime, No Restart)

Pi SDK extensions extend the **LLM tool set** at runtime via `pi.registerTool()`. No container restart needed.

```typescript
// Inside a Pi SDK extension (e.g., .pi/extensions/my-tool.ts)
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

### Extension discovery

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` | Global (all projects) |
| `.pi/extensions/*.ts` | Project-local |

### Pi SDK extension capabilities

- `pi.registerTool()` — add LLM-callable tools
- `pi.registerCommand()` — add slash commands
- `pi.registerShortcut()` — add keyboard shortcuts
- `pi.setActiveTools()` — enable/disable tools at runtime
- `pi.getAllTools()` — list all registered tools
- Subscribe to lifecycle events (tool calls, session start/end, agent turns)
- Intercept/block tool calls before execution
- Inject context or modify system prompts

---

## Workspace Bus Plugins (Restart-Based)

Bus plugins extend the **message bus** and are loaded from `workspace/plugins/` on container startup.

```typescript
// workspace/plugins/my-plugin.ts
import type { Plugin, EventBus, BusMessage } from "../../lib/types";

export default {
  name: "my-plugin",
  description: "Does something useful on the bus",
  capabilities: ["custom"],

  install(bus: EventBus) {
    bus.subscribe("message.inbound.#", "my-plugin", (msg: BusMessage) => {
      bus.publish("message.outbound.custom", {
        id: msg.id,
        topic: "message.outbound.custom",
        timestamp: Date.now(),
        payload: { content: "Custom response" },
      });
    });
  },

  uninstall() {},
} satisfies Plugin;
```

### Bus plugin capabilities

- Subscribe to any bus topic
- Publish messages to any topic
- Bridge external services (APIs, webhooks, databases)
- Transform or route messages between channels
- Implement custom command handlers

### Bus plugin limitations

- Cannot register LLM-callable tools (use Pi SDK extensions)
- Cannot modify the agent's system prompt
- Cannot intercept tool calls

---

## When to use which

| Goal | Use |
|------|-----|
| Add an LLM-callable tool | Pi SDK extension |
| Add a slash command | Pi SDK extension |
| React to bus messages | Workspace plugin |
| Bridge an external service | Workspace plugin |
| Intercept/block tool calls | Pi SDK extension |
| Route messages between channels | Workspace plugin |
| Add capabilities without restart | Pi SDK extension |

---

## MCP support

Pi SDK **does not ship MCP support**. MCP bridges are possible via extensions: write a Pi SDK extension that connects to MCP servers and registers their tools via `pi.registerTool()`.

---

## References

- [Pi SDK Extensions Docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi SDK Docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)
- Migrated from: [`extensions.md`](../extensions.md)

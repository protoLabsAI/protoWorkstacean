---
title: Plugin API Reference
---

_This is a reference doc. It covers the Plugin interface contract and how to write workspace bus plugins._

---

See also: [`explanation/plugin-lifecycle.md`](../explanation/plugin-lifecycle.md) for how plugins register, subscribe, and reload.

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

## Writing a workspace bus plugin

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

### Capabilities

- Subscribe to any bus topic
- Publish messages to any topic
- Bridge external services (APIs, webhooks, databases)
- Transform or route messages between channels
- Implement custom command handlers

### Limitations

- Cannot modify the agent's system prompt directly
- Cannot intercept tool calls at the LLM layer
- Hot reload requires a container restart (`docker restart workstacean`)

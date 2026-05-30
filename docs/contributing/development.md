---
title: Development Guide
---

## Setup

```bash
git clone https://github.com/protoLabsAI/protoWorkstacean.git
cd protoWorkstacean
bun install
```

Requires [Bun](https://bun.sh) >= 1.1. There is no Node.js build step — Bun runs TypeScript directly.

## Running the server locally

```bash
cp .env.dist .env          # then fill in at minimum ANTHROPIC_API_KEY and WORKSTACEAN_API_KEY
bun run src/index.ts
```

Use `--watch` during development for automatic restarts on file change:

```bash
bun run --watch src/index.ts
```

## Running tests

```bash
bun test
```

Tests are co-located with source. Test files follow the pattern `<name>.test.ts` or live in a `__tests__/` directory alongside the module they test.

```bash
# Run a single test file
bun test src/executor/__tests__/executor-registry.test.ts

# Run tests matching a pattern
bun test --test-name-pattern "resolution order"
```

There is no separate test runner configuration file — `bun test` discovers all `*.test.ts` files automatically.

## Test structure

Tests use `bun:test` — the same API as Jest/Vitest:

```typescript
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
```

**Unit tests** — co-located with source, mock all bus dependencies:

```typescript
// src/executor/__tests__/executor-registry.test.ts
import { describe, test, expect, mock } from "bun:test";
import { ExecutorRegistry } from "../executor-registry.ts";
import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";

function makeExecutor(type: string): IExecutor {
  return {
    type,
    execute: mock(async (req: SkillRequest): Promise<SkillResult> => ({
      text: `result from ${type}`,
      isError: false,
      correlationId: req.correlationId,
    })),
  };
}

describe("ExecutorRegistry", () => {
  test("resolves registered skill", () => {
    const registry = new ExecutorRegistry();
    const exec = makeExecutor("deep-agent");
    registry.register("daily_standup", exec);
    expect(registry.resolve("daily_standup")).toBe(exec);
  });
});
```

**Integration tests** — in `test/integration/`, use a real `InMemoryEventBus`:

```typescript
// test/integration/router-dispatch-flow.test.ts
import { describe, test, expect } from "bun:test";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { RouterPlugin } from "../../src/router/router-plugin.ts";
import { SkillDispatcherPlugin } from "../../src/executor/skill-dispatcher-plugin.ts";

describe("router → dispatcher integration", () => {
  test("inbound message routes to skill request", async () => {
    const bus = new InMemoryEventBus();
    // install plugins, publish a message.inbound.* event, assert the resolved
    // agent.skill.request arrives on the bus
  });
});
```

## Writing a plugin

Create `src/plugins/my-plugin.ts` and implement the `Plugin` interface:

```typescript
import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";

export class MyPlugin implements Plugin {
  readonly name = "my-plugin";
  readonly description = "Short description";
  readonly capabilities = ["my-capability"];

  private bus?: EventBus;
  private readonly subscriptionIds: string[] = [];

  install(bus: EventBus): void {
    this.bus = bus;
    const id = bus.subscribe("some.topic.#", this.name, (msg: BusMessage) => {
      void this._handle(msg);
    });
    this.subscriptionIds.push(id);
  }

  uninstall(): void {
    if (this.bus) {
      for (const id of this.subscriptionIds) {
        this.bus.unsubscribe(id);
      }
    }
    this.subscriptionIds.length = 0;
    this.bus = undefined;
  }

  private async _handle(msg: BusMessage): Promise<void> {
    // ... handle the message
  }
}
```

Wire it into `src/index.ts` in the `pluginRegistry` array:

```typescript
{
  name: "my-plugin",
  condition: () => true,           // or () => !!process.env.MY_ENV_VAR
  factory: async () => {
    const { MyPlugin } = await import("./plugins/my-plugin.js");
    return new MyPlugin();
  },
},
```

## Writing an executor

Implement `IExecutor` in `src/executor/executors/`:

```typescript
import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";

export class MyExecutor implements IExecutor {
  readonly type = "my-executor";

  async execute(req: SkillRequest): Promise<SkillResult> {
    try {
      const result = await doSomethingWith(req.content ?? req.skill);
      return { text: result, isError: false, correlationId: req.correlationId };
    } catch (err) {
      return {
        text: "",
        isError: true,
        correlationId: req.correlationId,
        data: { error: String(err) },
      };
    }
  }
}
```

Register it in a plugin's `install()` — do not subscribe to `agent.skill.request` directly:

```typescript
install(_bus: EventBus): void {
  this.registry.register("my_skill", new MyExecutor(), { priority: 5 });
}
```

## File structure

```
src/
  index.ts                     # Bootstrap and plugin wiring
  executor/
    types.ts                   # IExecutor, SkillRequest, SkillResult, ExecutorRegistration
    executor-registry.ts       # ExecutorRegistry
    skill-dispatcher-plugin.ts # Sole agent.skill.request subscriber
    executors/
      a2a-executor.ts
      deep-agent-executor.ts     # LangGraph — default in-process runtime
      function-executor.ts
      workflow-executor.ts
    __tests__/
  plugins/
    CeremonyPlugin.ts
    agent-fleet-health-plugin.ts
    alert-skill-executor-plugin.ts
    ceremony-skill-executor-plugin.ts
    pr-remediator-skill-executor-plugin.ts
    skill-broker-plugin.ts
  agent-runtime/
    agent-runtime-plugin.ts    # Registrar for in-process agents
    agent-definition-loader.ts
    types.ts
  router/
    router-plugin.ts
    skill-resolver.ts
    project-enricher.ts
  event-bus/
    topics.ts
    payloads.ts
  api/
    bus-topology.ts            # GET /api/bus/topology
    ...
lib/
  types.ts                     # BusMessage, Plugin (with publishes/subscribes), EventBus
  bus.ts                       # InMemoryEventBus
  plugins/
    discord.ts
    github.ts
    linear.ts
    google.ts
    pr-remediator.ts
    scheduler.ts
    a2a-delivery.ts
    operator-routing.ts
    ...
workspace/
  agents.yaml                  # A2A remote agents
  agents/                      # In-process agent YAMLs
  ceremonies/                  # Scheduled rituals
  crons/                       # Plain cron entries (created by SchedulerPlugin)
  channels.yaml                # Channel→agent + per-project channel bindings
test/
  integration/
tests/
  (schema and submission tests)
```

## Type checking

```bash
bunx tsc --noEmit
```

The project uses TypeScript strict mode. All exported types should have JSDoc comments on non-obvious fields.

## Conventions

- **Named exports only** in `.ts` files. Exception: `_meta.ts` files use a default export for Nextra.
- **No inter-plugin references** — plugins communicate through the bus.
- **Async handlers** — `bus.subscribe` callbacks should be `void` functions that internally handle errors with try/catch or `.catch()`. Do not let unhandled promise rejections propagate.
- **correlationId is sacred** — never generate a new `correlationId` mid-flow. Always propagate the one from the triggering message.
- **Imports** use `.ts` extensions (Bun resolves them correctly; avoid `.js` aliases in source files).

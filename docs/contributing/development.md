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
    const exec = makeExecutor("proto-sdk");
    registry.register("daily_standup", exec);
    expect(registry.resolve("daily_standup")).toBe(exec);
  });
});
```

**Integration tests** — in `test/integration/`, use a real `InMemoryEventBus`:

```typescript
// test/integration/planner-dispatcher-flow.test.ts
import { describe, test, expect } from "bun:test";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { PlannerPluginL0 } from "../../src/plugins/planner-plugin-l0.ts";

describe("GOAP loop integration", () => {
  test("planner dispatches action when preconditions match", async () => {
    const bus = new InMemoryEventBus();
    // install plugins, publish world state, assert action dispatched
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
      function-executor.ts
      proto-sdk-executor.ts
      workflow-executor.ts
    __tests__/
  plugins/
    CeremonyPlugin.ts
    goal_evaluator_plugin.ts
    planner-plugin-l0.ts
    action-dispatcher-plugin.ts
    skill-broker-plugin.ts
    ...
  agent-runtime/
    agent-runtime-plugin.ts    # Registrar for in-process agents
    agent-executor.ts
    agent-definition-loader.ts
    types.ts
    tool-registry.ts
  router/
    router-plugin.ts
    skill-resolver.ts
    project-enricher.ts
  world/
    domain-discovery.ts
  event-bus/
    topics.ts
    action-events.ts
lib/
  types.ts                     # BusMessage, Plugin, EventBus (shared)
  bus.ts                       # InMemoryEventBus
  plugins/
    world-state-engine.ts
    discord.ts
    github.ts
    ...
workspace/
  goals.yaml
  actions.yaml
  agents.yaml
  agents/
  ceremonies/
  domains.yaml
  projects.yaml
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

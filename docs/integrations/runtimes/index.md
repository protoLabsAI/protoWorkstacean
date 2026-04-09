---
title: Runtimes
---

Every agent in protoWorkstacean is wrapped in an `IExecutor` and registered in `ExecutorRegistry`. `SkillDispatcherPlugin` is the sole subscriber to `agent.skill.request` — it resolves the right executor and delegates. Adding a new agent type means implementing `IExecutor` and registering it; no changes to the dispatch path.

## Available runtimes

| Runtime | Type string | Package | When to use |
|---------|-------------|---------|-------------|
| [ProtoSdk](proto-sdk) | `proto-sdk` | `@protolabsai/sdk` | Default for all new agents — in-process |
| [A2A](a2a) | `a2a` | HTTP JSON-RPC 2.0 | Agent lives in a separate service |
| [Pi SDK](pi-sdk) | `agent` | `@mariozechner/pi-coding-agent` | Legacy — existing agents only |

## IExecutor interface

```typescript
interface IExecutor {
  readonly type: string;
  execute(req: SkillRequest): Promise<SkillResult>;
}
```

## SkillRequest

```typescript
interface SkillRequest {
  skill: string;            // Skill name (e.g. "sitrep", "pr_review")
  content?: string;         // Natural language task description
  prompt?: string;          // Explicit prompt override
  correlationId: string;    // Trace ID — never changes within a flow
  parentId?: string;        // Bus message.id that produced this request
  replyTopic: string;       // Topic to publish the response on
  payload: Record<string, unknown>;  // Full original payload
}
```

## SkillResult

```typescript
interface SkillResult {
  text: string;             // Output text. Empty string on error.
  isError: boolean;
  correlationId: string;    // Propagated trace ID
  data?: unknown;           // Structured data (function/workflow executors only)
}
```

## ExecutorRegistry resolution order

`ExecutorRegistry.resolve(skill, targets)` follows a strict priority order:

1. **Named target** — if `targets` contains an agent name, route there directly. Ceremonies and actions with `meta.agentId` use this path.
2. **Skill match** — find all registrations whose `skill` matches, sort by `priority` descending, take the first.
3. **Default executor** — registered via `registerDefault()`. Catches anything unmatched.
4. **null** — logged and dropped. Not an error — means no agent has claimed this skill.

## Other executor types

### FunctionExecutor

Wraps a plain async function. No agent or LLM call involved.

```typescript
type SkillFn = (req: SkillRequest) => Promise<SkillResult>;
new FunctionExecutor(fn: SkillFn)
```

Use for data transformations, in-process state mutations, or test stubs.

### WorkflowExecutor

Executes a sequence of skill steps, each resolved from the registry, with a shared `correlationId`.

```typescript
new WorkflowExecutor(
  steps: Array<{ skill: string; targets?: string[] }>,
  registry: ExecutorRegistry
)
```

Use for multi-step workflows where output from one skill feeds the next.

## Writing a new executor

```typescript
class MyCustomExecutor implements IExecutor {
  readonly type = "my-custom";

  async execute(req: SkillRequest): Promise<SkillResult> {
    return {
      text: "result",
      isError: false,
      correlationId: req.correlationId,
    };
  }
}
```

Register it in a plugin's `install()`:

```typescript
install(bus: EventBus): void {
  this.registry.register("my_skill", new MyCustomExecutor(), { priority: 5 });
}
```

No changes to `SkillDispatcherPlugin` needed.

## The registrar pattern

`AgentRuntimePlugin` and `SkillBrokerPlugin` are pure registrars — they have no bus subscriptions. Their entire `install()` creates executors and calls `registry.register()`. This is intentional: subscriptions create coupling; registrars do not. Two registrars can coexist safely. The dispatch concern is entirely isolated in `SkillDispatcherPlugin`.

---
title: Executor Layer
---

## Why it exists

Before the executor layer, protoWorkstacean had two competing patterns for dispatching work to agents:

- `AgentPlugin` — a catch-all subscriber that hard-coded the Pi SDK and had no concept of skill routing
- `A2APlugin` — a separate subscriber that knew how to call ava over HTTP, but also subscribed to `message.inbound.#` directly

This meant two plugins were racing for the same messages. Adding a third agent type (e.g. an in-process Claude Code SDK agent) would require a third subscriber with its own routing logic. There was no single place to ask "which agent handles this skill?"

The executor layer solves this by separating **registration** from **dispatch**:

- Plugins that know about agents (`AgentRuntimePlugin`, `SkillBrokerPlugin`) register executors into `ExecutorRegistry` at `install()` time
- `SkillDispatcherPlugin` is the **sole subscriber** to `agent.skill.request` and delegates to the registry
- Adding a new agent type means writing a new `IExecutor` implementation and registering it — no changes to the dispatch path

## The registrar pattern

`AgentRuntimePlugin` and `SkillBrokerPlugin` are pure registrars. They have no bus subscriptions. Their entire `install()` method creates executors and calls `registry.register()`. Their `uninstall()` does nothing to the bus.

This is intentional. Subscriptions create coupling: a subscriber that handles a topic "owns" that topic and conflicts with other subscribers. Registrars have no such coupling — two registrars can coexist safely, registering different executors for different skills.

The dispatch concern is entirely isolated in `SkillDispatcherPlugin`. Exactly one plugin subscribes to `agent.skill.request`. This makes it easy to reason about what happens when a skill request arrives: there is exactly one code path.

## Resolution order

`ExecutorRegistry.resolve(skill, targets)` follows a strict priority order:

1. **Named target** — if `targets` contains an agent name, route there directly. This lets callers bypass skill-based routing entirely. Ceremonies use this (a ceremony targets `ava` specifically). Actions use it too when `meta.agentId` is set.

2. **Skill match** — find all registrations whose `skill` equals the request's `skill`. Sort by `priority` descending, take the first. This is the normal path: skill keywords route to whichever agent declared that skill.

3. **Default executor** — a catch-all registered with `registerDefault()`. Useful for a fallback LLM agent that handles anything unmatched.

4. **null** — logged and dropped. This is not an error in the traditional sense — it means no agent has claimed responsibility for this skill. The system keeps running.

Why this order? Named targets trump skill matching because explicit is better than implicit. If a ceremony explicitly says "send this to ava", we should respect that even if another agent also declares the same skill. The default is last because it is a catch-all — it should only fire when nothing more specific matches.

## Why SkillDispatcherPlugin sets parentId

When a bus message triggers a skill request, the message's `id` becomes the `parentId` on the `SkillRequest`. This is the span boundary: the bus message is a parent span, and the skill execution is a child span within the same trace (`correlationId` unchanged).

`SkillDispatcherPlugin` does this in one place, consistently, for all executors. If each executor set its own `parentId`, the semantics would diverge and distributed traces would be inconsistent.

## What a new executor type looks like

```typescript
class MyCustomExecutor implements IExecutor {
  readonly type = "my-custom";

  async execute(req: SkillRequest): Promise<SkillResult> {
    // ... do work with req.skill, req.content, req.correlationId ...
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

That's the full extension contract. No changes to `SkillDispatcherPlugin`, no new bus subscriptions.

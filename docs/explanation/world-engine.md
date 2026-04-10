---
title: World Engine
---

## The core idea

protoWorkstacean is a homeostatic system. "Homeostatic" means it maintains a desired state by continuously measuring deviations and applying corrective actions. The world engine is the measurement side: it builds a faithful model of reality (the world state) and evaluates whether that reality satisfies the system's declared goals.

The three-stage pipeline is:

```
WorldStateEngine → GoalEvaluatorPlugin → PlannerPluginL0 → ActionDispatcherPlugin
```

Each stage has a narrow, well-defined responsibility. None of them knows about agents, LLMs, or the bus topology. They deal only with data: domains, goals, actions, and state transitions.

## Why WorldState is Record<string, unknown>

An earlier design had `WorldState.domains` typed as a sum type with specific keys for known domains (`board`, `ci`, `services`, `security`, `agent_health`). This was a mistake.

Hard-coding domain names into the type system means every new integration requires a TypeScript type change. It leaks the assumption that workstacean always runs in the same environment with the same set of services. A team that runs workstacean against different infrastructure can't add their own domains without forking the type.

`WorldState = Record<string, unknown>` removes this coupling entirely. Any domain can exist. Goals and actions reference domains by dot-path strings (`domains.my_service.data.value`). The evaluator resolves these paths at evaluation time using a simple `get(obj, path)` utility. The type system makes no promises about what domains exist — that's a runtime configuration concern, not a compile-time concern.

The cost is that there's no compile-time check that a `selector` path is valid. The benefit is that the world engine works for any combination of HTTP endpoints, with zero code changes.

## Generic domain registration

`WorldStateEngine.registerDomain(name, collector, tickMs)` is the only API. A collector is any function `() => Promise<unknown>`. The world engine doesn't care what the collector does — it polls it, stores the result under `domains.<name>.data`, and publishes `world.state.updated`.

`createHttpCollector(url, opts)` is a factory for the common case of polling an HTTP endpoint. But because the collector is a plain function, you can register:

- Mock collectors for testing
- Collectors that read from files
- Collectors that aggregate multiple endpoints
- Collectors that compute derived data from other domains

This is not a currently documented extension point, but the architecture supports it cleanly because the world engine depends on the `() => Promise<unknown>` interface, not on HTTP.

## Domain discovery rationale

WorldStateEngine learns about domains from `workspace/domains.yaml` and per-project `domains.yaml` files (discovered via `projects.yaml`). This is loaded at startup via a `discoverAndRegister()` call, not hardcoded.

The key decision here is that domain configuration lives outside the codebase. You can change which services are monitored by editing YAML files, without redeploying. This matters in production: adding a new service to monitor shouldn't require a code review and deployment pipeline.

Per-project domains allow each project to define the world-state data it cares about. A project with a custom CI system can add a domain for it without polluting the global domain config.

## The GOAP loop

The GOAP (Goal-Oriented Action Planning) loop runs continuously alongside domain polling:

**WorldStateEngine** fires `world.state.updated` after every domain poll.

**GoalEvaluatorPlugin** subscribes to `world.state.updated`. For each updated domain, it evaluates all loaded goals:
- `Threshold` goals: checks `value < min || value > max`
- `Invariant` goals: checks boolean operator against a world-state value
- `Distribution` goals: checks proportions against target distributions within tolerance

When a goal is violated, it emits `world.goal.violated` with the goal ID, severity, and the current world-state snapshot.

**PlannerPluginL0** subscribes to `world.goal.violated`. It queries `ActionRegistry` for actions whose `goalId` matches the violated goal and whose `preconditions` are satisfied against the current world state. It packages the selected actions into a `world.action.plan` message.

**ActionDispatcherPlugin** subscribes to `world.action.plan`. It fires each action by publishing to `action.meta.topic`, subject to a WIP (work-in-progress) limit to prevent runaway firing.

## Why tier_0 vs tier_1 vs tier_2

Tier_0 actions are deterministic and cheap: send an alert, trigger a ceremony. They require no planning — if the preconditions are met, fire immediately.

Tier_1 actions require A*-based sequencing. When multiple goals are violated simultaneously, the planner needs to reason about which combination of actions resolves them efficiently. The `cost` field and `effects` array are used by the planner to simulate state transitions and find a minimum-cost plan.

Tier_2 actions delegate to an LLM agent. The planner hands off to ava or another agent to decide what to do. This is appropriate when the required action is contextual — it depends on information outside the world state (e.g. reading a CI log, understanding a PR description).

Most production goals should be tier_0 (alert) + tier_0 (ceremony trigger). Tier_1 and tier_2 are for workflows that require multi-step recovery or autonomous judgment.

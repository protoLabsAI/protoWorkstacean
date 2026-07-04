---
title: Explanation
---

These docs explain the *why* behind protoWorkstacean's architecture. Read them when you want to understand the reasoning behind a design decision, not just what the system does.

## Available explanations

| Document | What it explains |
|----------|-----------------|
| [Architecture](./architecture) | The switchboard shape: trigger → router → dispatcher → executor. Why this is the whole product. |
| [Executor layer](../integrations/runtimes/) | Why the executor layer exists, how resolution works, the registrar pattern, health-weighted multi-agent selection, and why `SkillDispatcherPlugin` is the sole `agent.skill.request` subscriber |
| [Distributed tracing](./distributed-tracing) | How `correlationId` (trace-id) and `parentId` (span-id) flow from the bus through RouterPlugin, A2AExecutor, external agents, and back |
| [Plugin system](./plugin-system) | The plugin lifecycle, core vs integration vs workspace plugins, ordering guarantees |
| [Agent identity](./agent-identity) | How agents identify themselves across Discord, GitHub, A2A, and the bus |
| [Operator flows](./operator-flows) | End-to-end: onboarding a project, the project registry, PR review with Quinn, and routing — who owns each step |
| [Decisions (ADRs)](../decisions/) | The locked, load-bearing direction — recorded decisions and where the fleet is heading. Includes historical, now-superseded ADRs. |

## Design philosophy

protoWorkstacean is built around three ideas:

1. **The bus is the contract.** Plugins communicate only through typed bus messages. No plugin holds a direct reference to another plugin. This makes it safe to add, remove, or replace plugins without touching existing code. Plugins declare their `publishes` and `subscribes` topic patterns so the dependency graph is inspectable via `GET /api/bus/topology`.

2. **The switchboard has no agency.** Triggers come in, the router resolves them to a skill, the dispatcher routes the skill to an executor. Decisions about *what to do* live in the agents, schedules, and integrations — not in the routing layer.

3. **Executors are interchangeable.** Whether a skill runs in-process via LangGraph (`DeepAgentExecutor`) or over HTTP via A2A JSON-RPC (`A2AExecutor`), the bus sees no difference. The executor layer is an internal seam, not an external protocol boundary.

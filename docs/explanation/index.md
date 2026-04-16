---
title: Explanation
---

These docs explain the *why* behind protoWorkstacean's architecture. Read them when you want to understand the reasoning behind a design decision, not just what the system does.

## Available explanations

| Document | What it explains |
|----------|-----------------|
| [Executor layer](../integrations/runtimes/) | Why the executor layer exists, how resolution works, the registrar pattern, health-weighted multi-agent selection (Arc 8.4), and why `SkillDispatcherPlugin` is the sole `agent.skill.request` subscriber |
| [World engine](./world-engine) | Why `WorldState` is a generic record, the GOAP loop design, domain discovery rationale |
| [Self-improving loop](./self-improving-loop) | How A2A extensions feed observations into `PlannerPluginL0`'s candidate ranking, how episodic memory writes to Graphiti, and why the convergence loops don't diverge |
| [Distributed tracing](./distributed-tracing) | How `correlationId` (trace-id) and `parentId` (span-id) flow from the bus through RouterPlugin, A2AExecutor, external agents (protoMaker team, Quinn), and back |
| [Plugin system](./plugin-system) | The plugin lifecycle, core vs integration vs workspace plugins, ordering guarantees |
| [Cross-channel conversations](../integrations/channels) | How `ChannelRegistry` maps channels → agents, how `ConversationManager` maintains stable `conversationId` across DM and guild turns, and how memory enrichment now applies to all channels |

## Design philosophy

protoWorkstacean is built around three ideas:

1. **The bus is the contract.** Plugins communicate only through typed bus messages. No plugin holds a direct reference to another plugin. This makes it safe to add, remove, or replace plugins without touching existing code.

2. **World state is ground truth.** The GOAP loop does not make decisions based on ephemeral signals. It polls durable HTTP domains, computes a world state snapshot, and evaluates goals against that snapshot. Goals are declarative invariants — the system continuously works to satisfy them.

3. **Executors are interchangeable.** Whether a skill runs in-process via LangGraph (`DeepAgentExecutor`) or over HTTP via A2A JSON-RPC (`A2AExecutor`), the bus sees no difference. The executor layer is an internal seam, not an external protocol boundary.

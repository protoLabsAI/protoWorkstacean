---
title: Explanation
---

# Explanation

These docs explain the *why* behind protoWorkstacean's architecture. Read them when you want to understand the reasoning behind a design decision, not just what the system does.

## Available explanations

| Document | What it explains |
|----------|-----------------|
| [Executor layer](./executor-layer.md) | Why the executor layer exists, how resolution works, the registrar pattern, and why `SkillDispatcherPlugin` is the sole `agent.skill.request` subscriber |
| [World engine](./world-engine.md) | Why `WorldState` is a generic record, the GOAP loop design, domain discovery rationale |
| [Distributed tracing](./distributed-tracing.md) | How `correlationId` (trace-id) and `parentId` (span-id) flow from the bus through RouterPlugin, A2AExecutor, ava, and back |
| [Plugin system](./plugin-system.md) | The plugin lifecycle, core vs integration vs workspace plugins, ordering guarantees |

## Design philosophy

protoWorkstacean is built around three ideas:

1. **The bus is the contract.** Plugins communicate only through typed bus messages. No plugin holds a direct reference to another plugin. This makes it safe to add, remove, or replace plugins without touching existing code.

2. **World state is ground truth.** The GOAP loop does not make decisions based on ephemeral signals. It polls durable HTTP domains, computes a world state snapshot, and evaluates goals against that snapshot. Goals are declarative invariants — the system continuously works to satisfy them.

3. **Executors are interchangeable.** Whether a skill runs in-process via the Claude Code SDK or over HTTP via A2A JSON-RPC, the bus sees no difference. The executor layer is an internal seam, not an external protocol boundary.

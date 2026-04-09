---
title: Pi SDK Runtime (Legacy)
---

`AgentPlugin` runs a skill as an in-process session using `@mariozechner/pi-coding-agent` (the Pi SDK). This is the **legacy runtime** — it predates `ProtoSdkExecutor` and remains in the codebase for existing agents that have not yet been migrated.

**Type string**: `agent`
**Package**: `@mariozechner/pi-coding-agent`
**Source**: `lib/plugins/agent.ts`

New agents should use [ProtoSdk](proto-sdk) instead.

## How it works

`AgentPlugin` subscribes directly to `message.inbound.#` on the bus. When a message arrives:

1. It creates a Pi SDK `AgentSession` via `createAgentSession()`
2. Injects coding tools (`createCodingTools`) scoped to the agent's workspace directory
3. Runs the session with the inbound message content as the user prompt
4. Publishes the response back to the appropriate outbound topic

Unlike `ProtoSdkExecutor`, `AgentPlugin` is not registered in `ExecutorRegistry` — it subscribes directly to the bus and handles its own routing logic.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | API key sent to the LLM gateway |
| `OPENAI_BASE_URL` | Base URL for the LLM gateway (overrides `LLM_GATEWAY_URL`) |

## Limitations vs ProtoSdk

| Capability | Pi SDK (`AgentPlugin`) | ProtoSdk (`ProtoSdkExecutor`) |
|---|---|---|
| Skill-based routing | No — catches all `message.inbound.#` | Yes — registered per skill in ExecutorRegistry |
| Multi-agent coexistence | Fragile — races with other subscribers | Clean — single dispatcher, no races |
| Agent YAML definition | No | Yes |
| LangFuse tracing | No | Yes |
| `correlationId` propagation | Partial | Full |
| Active development | No | Yes |

## When to keep using it

Only use `AgentPlugin` for agents that have not yet been migrated to `ProtoSdkExecutor`. For all new agents, use the [ProtoSdk runtime](proto-sdk).

## Migration path

To migrate an agent from Pi SDK to ProtoSdk:

1. Create a `workspace/agents/<name>.yaml` with the agent's system prompt and skill list
2. Remove the `AgentPlugin` instantiation from `src/index.ts`
3. Verify `AgentRuntimePlugin` picks up the new YAML and registers the executor
4. Update tests to use the new executor pattern (`scheduler.test.ts` is a good model)

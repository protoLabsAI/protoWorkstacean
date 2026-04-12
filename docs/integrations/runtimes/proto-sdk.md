---
title: ProtoSdk Runtime
---

`ProtoSdkExecutor` runs a skill as an in-process @protolabsai/sdk session. This is the default runtime for all new agents defined in `workspace/agents/*.yaml`.

**Type string**: `proto-sdk`
**Package**: `@protolabsai/sdk`
**Registered by**: `AgentRuntimePlugin` — one executor per agent YAML file at `install()` time.

## How it works

1. `AgentRuntimePlugin` scans `workspace/agents/` on startup and creates one `ProtoSdkExecutor` per YAML file
2. Each executor is registered in `ExecutorRegistry` for the skills listed in the agent's YAML
3. When `SkillDispatcherPlugin` routes a `SkillRequest` to this executor, it:
   - Instantiates a @protolabsai/sdk session with the agent's `systemPrompt`
   - Injects the whitelisted `tools` as MCP tools
   - Runs up to `maxTurns` agentic turns
   - Returns the final assistant message as `SkillResult.text`
   - Propagates `correlationId` through the session context

## Agent YAML definition

```yaml
# workspace/agents/my-agent.yaml
name: my-agent
executor: proto-sdk
systemPrompt: |
  You are a helpful assistant...
skills:
  - name: my_skill
    description: Does something useful
maxTurns: 10
tools:
  - bash
  - read
  - write
```

See [Agent Skills Reference](../../../reference/agent-skills) for the full YAML schema and available tools.

## LLM gateway

All LLM calls route through the LiteLLM proxy at `LLM_GATEWAY_URL`. The executor sends requests as `OPENAI_API_KEY` Bearer tokens to `OPENAI_BASE_URL` (or `LLM_GATEWAY_URL` if `OPENAI_BASE_URL` is not set).

For direct Anthropic API access (no gateway), set `ANTHROPIC_API_KEY` instead.

## Observability

If `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set, every session is traced to LangFuse with the `correlationId` as the trace ID.

## When to use

Use `ProtoSdkExecutor` for any agent that should run inside the workstacean process with direct access to the workstacean bus tools. This is the right choice for most agents.

Use [A2A](a2a) instead when the agent lives in a separate service (e.g. the protoMaker team, quinn, protoContent) or needs its own resource isolation.

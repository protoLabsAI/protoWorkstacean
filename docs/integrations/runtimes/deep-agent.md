---
title: DeepAgent Runtime (LangGraph)
---

`DeepAgentExecutor` runs in-process agents via LangGraph's `createReactAgent`. This is the default runtime for all agents defined in `workspace/agents/*.yaml`.

**Type string**: `deep-agent`
**Package**: `@langchain/langgraph` + `@langchain/openai`
**Registered by**: `AgentRuntimePlugin` — one executor per agent YAML file at `install()` time.

## How it works

1. `AgentRuntimePlugin` scans `workspace/agents/` on startup and creates one `DeepAgentExecutor` per YAML file
2. Each executor is registered in `ExecutorRegistry` for the skills listed in the agent's YAML
3. When `SkillDispatcherPlugin` routes a `SkillRequest` to this executor, it:
   - Creates a LangGraph ReAct agent with `ChatOpenAI` pointed at the LiteLLM gateway
   - Injects the agent's `systemPrompt` as a `SystemMessage`
   - Provides LangChain tools matching the `tools` whitelist from the agent YAML
   - Runs the agent loop with `recursionLimit` derived from `maxTurns`
   - Returns the final AI message as `SkillResult.text`

## Agent YAML definition

```yaml
# workspace/agents/ava.yaml
name: ava
role: general
model: claude-sonnet-4-6

systemPrompt: |
  You are Ava, the chief-of-staff protoAgent...

tools:
  - chat_with_agent
  - delegate_task
  - get_world_state
  - manage_board
  - create_github_issue
  - manage_cron

maxTurns: 10

discordBotTokenEnvKey: DISCORD_BOT_TOKEN_AVA

skills:
  - name: chat
    description: Conversational hub with system visibility and delegation.
    keywords: []
```

See [Agent Skills Reference](../../../reference/agent-skills) for the full YAML schema and available tools.

## Available tools

Tools are defined as LangChain tools with zod schemas in `DeepAgentExecutor`. Each wraps an HTTP call to workstacean's own API:

| Tool | API endpoint | Purpose |
|------|-------------|---------|
| `chat_with_agent` | `POST /api/a2a/chat` | Multi-turn A2A conversation |
| `delegate_task` | `POST /api/a2a/delegate` | Fire-and-forget dispatch |
| `get_world_state` | `GET /api/world-state` | System health snapshot |
| `manage_board` | `POST /api/board/features/*` | Board feature CRUD |
| `create_github_issue` | `POST /api/github/issues` | File GitHub issues |
| `manage_cron` | `POST /api/ceremonies/*` | Ceremony CRUD |
| `get_projects` | `GET /api/projects` | List projects |
| `get_ci_health` | `GET /api/ci-health` | CI pass rates |
| `get_pr_pipeline` | `GET /api/pr-pipeline` | Open PRs and CI status |
| `get_branch_drift` | `GET /api/branch-drift` | Dev vs main divergence |
| `get_incidents` | `GET /api/incidents` | Open incidents |
| `report_incident` | `POST /api/incidents` | File incident |
| `publish_event` | `POST /publish` | Raw bus event |

Agents only get the tools listed in their `tools:` array — unlisted tools are not available.

## LLM gateway

All LLM calls route through LiteLLM at `LLM_GATEWAY_URL` (or `OPENAI_BASE_URL`). The executor creates a `ChatOpenAI` instance with the gateway as `baseURL` and `OPENAI_API_KEY` for auth. Model aliases (e.g. `claude-sonnet-4-6`) are resolved by the gateway.

## Observability

`correlationId` from the bus message is propagated through the LangGraph invocation. When `LANGFUSE_*` env vars are set, the LangChain callback handler traces every LLM call and tool invocation to Langfuse.

## When to use

Use `DeepAgentExecutor` for any agent that should run inside the workstacean process with direct access to bus tools. This is the right choice for most agents.

Use [A2A](a2a) instead when the agent lives in a separate service (Quinn, protoMaker team, protoContent) or needs its own resource isolation.

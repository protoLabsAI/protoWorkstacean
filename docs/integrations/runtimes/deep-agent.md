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
   - Resolves the system prompt: if the matched skill has `systemPromptOverride`, uses that; otherwise uses the agent's `systemPrompt`
   - Appends a cached world state snapshot for instant situational awareness
   - Provides LangChain tools matching the `tools` whitelist from the agent YAML
   - Runs the agent loop with `recursionLimit` derived from `maxTurns`
   - Returns the final AI message as `SkillResult.text`

## Agent YAML definition

```yaml
# workspace/agents/ava.yaml
name: ava
role: general
model: claude-opus-4-6

systemPrompt: |
  You are Ava, the chief-of-staff protoAgent...

tools:
  # Orchestration
  - chat_with_agent
  - delegate_task
  - publish_event
  - manage_cron
  - run_ceremony
  # Observation
  - get_world_state
  - get_projects
  - get_ci_health
  - get_pr_pipeline
  - get_branch_drift
  - get_outcomes
  - get_incidents
  - get_cost_summary
  - get_confidence_summary
  - web_search
  # Write / Act
  - manage_board
  - create_github_issue
  - report_incident
  - propose_config_change
  # Conversation
  - react
  - send_update
  - msg_operator

maxTurns: 25

discordBotTokenEnvKey: DISCORD_BOT_TOKEN_AVA

skills:
  - name: chat
    description: Operational helm — the user's single control interface.
    keywords: []

  - name: goal_proposal
    description: Draft goals.yaml entries from chronic failure clusters.
    keywords: [goal, proposal, cluster, outcome]
    systemPromptOverride: |
      You are Ava performing a goal proposal analysis...

  - name: debug_ci_failures
    description: Investigate CI failures, delegate to Quinn, file issues.
    keywords: [ci, failure, build, pipeline]
```

### Skill-level `systemPromptOverride`

When a skill declares `systemPromptOverride`, the executor uses it instead of the agent's main `systemPrompt` for that specific invocation. This allows structured-output skills (like `goal_proposal` and `diagnose_pr_stuck`) to use narrow, format-enforcing prompts while operational skills use the full conversational prompt.

See [Agent Skills Reference](../../../reference/agent-skills) for the full YAML schema and available tools.

## Available tools

Tools are defined as LangChain tools with zod schemas in `DeepAgentExecutor`. Each wraps an HTTP call to workstacean's own API. Agents only get the tools listed in their `tools:` array — unlisted tools are not available.

### Orchestration

| Tool | API endpoint | Purpose |
|------|-------------|---------|
| `chat_with_agent` | `POST /api/a2a/chat` | Multi-turn A2A conversation with another agent |
| `delegate_task` | `POST /api/a2a/delegate` | Fire-and-forget dispatch to an agent |
| `publish_event` | `POST /publish` | Inject a raw bus event |
| `manage_cron` | `POST /api/ceremonies/*` | CRUD scheduled ceremonies |
| `run_ceremony` | `POST /api/ceremonies/:id/run` | Manually trigger a ceremony |

### Observation

| Tool | API endpoint | Purpose |
|------|-------------|---------|
| `get_world_state` | `GET /api/world-state` | Full system health snapshot (all domains) |
| `get_projects` | `GET /api/projects` | List registered projects |
| `get_ci_health` | `GET /api/ci-health` | CI pass rates across repos |
| `get_pr_pipeline` | `GET /api/pr-pipeline` | Open PRs: total, conflicts, stale, failing CI |
| `get_branch_drift` | `GET /api/branch-drift` | Dev vs main divergence per project |
| `get_outcomes` | `GET /api/world-state` | GOAP action dispatch outcomes |
| `get_incidents` | `GET /api/incidents` | Open security/operational incidents |
| `get_ceremonies` | `GET /api/ceremonies` | List ceremony definitions |
| `get_cost_summary` | `GET /api/cost-summaries` | Per-agent/skill cost: tokens, duration, dollars |
| `get_confidence_summary` | `GET /api/confidence-summaries` | Per-agent/skill calibration metrics |
| `web_search` | SearXNG `/search` | Quick web search (5 results) |

### Write / Act

| Tool | API endpoint | Purpose |
|------|-------------|---------|
| `manage_board` | `POST /api/board/features/*` | Create or update board features |
| `create_github_issue` | `POST /api/github/issues` | File GitHub issues on managed repos |
| `report_incident` | `POST /api/incidents` | File a security/operational incident |
| `propose_config_change` | `POST /api/config-change/propose` | Propose YAML changes (goals, actions, agent configs) — requires human approval via Discord |

### Conversation feedback

| Tool | API endpoint | Purpose |
|------|-------------|---------|
| `react` | `POST /api/discord/react` | Add emoji reaction to triggering message |
| `send_update` | `POST /api/discord/progress` | Send progress update during long work |
| `msg_operator` | `POST /api/operator/message` | Direct message to human operator with urgency |

### Discord operations (protoBot agent)

| Tool | API endpoint | Purpose |
|------|-------------|---------|
| `discord_server_stats` | `GET /api/discord/server-stats` | Server stats: members, channels, roles |
| `discord_list_channels` | `GET /api/discord/channels` | List all channels |
| `discord_create_channel` | `POST /api/discord/channels/create` | Create a channel |
| `discord_send` | `POST /api/discord/send` | Send a message to a channel |
| `discord_list_members` | `GET /api/discord/members` | List server members |

## LLM gateway

All LLM calls route through LiteLLM at `LLM_GATEWAY_URL` (or `OPENAI_BASE_URL`). The executor creates a `ChatOpenAI` instance with the gateway as `baseURL` and `OPENAI_API_KEY` for auth. Model aliases (e.g. `claude-sonnet-4-6`) are resolved by the gateway.

## Observability

`correlationId` from the bus message is propagated through the LangGraph invocation. When `LANGFUSE_*` env vars are set, the LangChain callback handler traces every LLM call and tool invocation to Langfuse.

## When to use

Use `DeepAgentExecutor` for any agent that should run inside the workstacean process with direct access to bus tools. This is the right choice for most agents.

Use [A2A](a2a) instead when the agent lives in a separate service (Quinn, protoMaker team, protoContent) or needs its own resource isolation.

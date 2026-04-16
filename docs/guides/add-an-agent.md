---
title: Add an Agent
---

protoWorkstacean supports two agent patterns:

- **In-process** — the agent runs inside the workstacean process, powered by LangGraph's `createReactAgent`. Skills execute as LangGraph ReAct sessions with a configurable system prompt, model (via the LiteLLM gateway), and tool whitelist. Example today: `ava` (conversational chat + fleet-delegation tools).
- **External A2A** — the agent runs in a separate service with its own HTTP surface. protoWorkstacean calls it over JSON-RPC 2.0. Right choice for stateful agents with their own infrastructure. Examples today: the **protoMaker team** (at `${AVA_BASE_URL}/a2a`, handles board ops and planning), **Quinn** (PR review, bug triage), **protoContent** (Jon/Cindi content), **Frank** (infra).

Both patterns register into `ExecutorRegistry` and are dispatched by `SkillDispatcherPlugin`. From the bus's perspective they are identical — both consume `agent.skill.request` and reply on `agent.skill.response.<correlationId>`.

## Path A: In-process agent

In-process agents are defined in `workspace/agents/<name>.yaml`. `AgentRuntimePlugin` reads all `.yaml` files in that directory at startup and registers a `DeepAgentExecutor` for each one.

### YAML schema

```yaml
# workspace/agents/my-agent.yaml

# Unique agent name — used for routing and logging.
name: my-agent

# Role affects how the agent is described in logs and the /api/agents endpoint.
# Options: orchestrator | qa | devops | content | research | general
role: general

# LLM model alias recognised by your gateway.
model: claude-sonnet-4-6

# Full system prompt injected on every turn.
systemPrompt: |
  You are My Agent, a specialist in...

# Workstacean bus tools this agent may call.
# Available tools: publish_event, get_world_state, get_incidents, report_incident,
#                  get_ceremonies, run_ceremony
tools:
  - get_world_state
  - publish_event

# Agent names this agent may delegate work to (at most 2 levels deep).
# Must match names of other agent definitions.
canDelegate: []

# Max agentic turns per skill invocation. -1 = unlimited.
maxTurns: 15

# Skills this agent handles.
# name must match the skillHint arriving on agent.skill.request.
# keywords are matched case-insensitively against message content for auto-routing.
skills:
  - name: my_skill
    description: "What this skill does"
    keywords: [keyword1, keyword2, /my-command]

  - name: another_skill
    description: "Another capability"
    # No keywords — dispatched programmatically only (e.g. from ceremonies or actions)
```

### How routing works

When a `agent.skill.request` message arrives, `SkillDispatcherPlugin` calls `ExecutorRegistry.resolve(skill, targets)`:

1. If `targets` is non-empty (explicit agent routing), the first target whose `agentName` matches an `AgentRuntimePlugin` registration wins.
2. Otherwise, it looks for a registration whose `skill` matches — which is set by the `skills[].name` entries in the YAML.
3. If nothing matches, the default executor (if any) handles it.

`RouterPlugin` sets the `skill` field based on:
1. `payload.skillHint` — set explicitly by surface plugins (Discord slash commands, cron events)
2. Keyword matching against the message content using `skills[].keywords`
3. `ROUTER_DEFAULT_SKILL` environment variable — catch-all fallback

### Registering the executor

`AgentRuntimePlugin` calls `executorRegistry.register(skill.name, executor, { agentName: agent.name })` for each skill in the YAML. No restart is required if you add a new agent file — restart is required currently; hot-reload is not implemented for agent definitions.

### Minimal example

```yaml
# workspace/agents/helper.yaml
name: helper
role: general
model: claude-haiku-4-5-20251001
systemPrompt: |
  You are Helper. Answer questions concisely.
tools: []
maxTurns: 5
skills:
  - name: answer
    description: Answer a question
    keywords: [help, question, ?]
```

Test it:

```bash
curl -X POST http://localhost:3000/publish \
  -H "X-API-Key: $WORKSTACEAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "agent.skill.request",
    "payload": {
      "skill": "answer",
      "content": "What time is it?",
      "correlationId": "test-001",
      "replyTopic": "agent.skill.response.test-001"
    }
  }'
```

---

## Path B: External A2A agent

External agents are defined in `workspace/agents.yaml`. `SkillBrokerPlugin` reads this file at startup and registers an `A2AExecutor` for each skill declared.

### YAML schema

```yaml
# workspace/agents.yaml

agents:
  - name: my-service
    # Full URL of the agent's /a2a endpoint (JSON-RPC 2.0).
    url: http://my-service:8080/a2a
    # Auth — either the legacy apiKeyEnv shorthand OR a structured auth block.
    apiKeyEnv: MY_SERVICE_API_KEY   # legacy: X-API-Key: <env>
    # auth:                          # preferred (Phase 8):
    #   scheme: bearer               # "apiKey" | "bearer" | "hmac"
    #   credentialsEnv: MY_SERVICE_TOKEN
    # Optional: stamp static headers (e.g. opt in to A2A extensions).
    # headers:
    #   a2a-extensions: "https://a2a-protocol.org/ext/cost-v1"
    # Whether the agent supports SSE streaming (card-derived fallback).
    streaming: false
    # Skills this agent handles. Omit to auto-discover from the agent card.
    skills:
      - name: analyze_data
        description: Analyze a dataset and return a summary
      - name: generate_report
        description: Generate a formatted report
    # Bus topics this agent subscribes to directly (informational — not enforced by workstacean).
    subscribesTo:
      - message.inbound.#
```

Auth resolution:
- `apiKeyEnv: X` → sends `X-API-Key: $X` on every request (legacy shorthand).
- `auth.scheme: apiKey` + `credentialsEnv: X` → same header, explicit scheme.
- `auth.scheme: bearer` + `credentialsEnv: X` → sends `Authorization: Bearer $X`.
- `auth.scheme: hmac` → reserved for future HMAC-signing extension.

At request time, `A2AExecutor` reads `process.env[credentialsEnv]` (or `apiKeyEnv` as fallback) and stamps the right header based on scheme.

### How the A2A call is made

`A2AExecutor` sends a `message/send` JSON-RPC 2.0 request:

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "<skill content>" }]
    },
    "contextId": "<correlationId>",
    "metadata": {
      "skillHint": "<skill>",
      "correlationId": "<correlationId>",
      "parentId": "<parentId>"
    }
  }
}
```

Distributed trace headers are always included:

```
X-Correlation-Id: <correlationId>
X-Parent-Id: <parentId>   (if present)
X-API-Key: <resolved key>
```

The receiving service should propagate `contextId` / `X-Correlation-Id` through its own spans.

### Skills refreshed from the agent card

You can omit `skills` from `agents.yaml` if your service exposes a `/.well-known/agent-card.json` (or legacy `/.well-known/agent.json`) discovery endpoint. `SkillBrokerPlugin` fetches it at startup and registers declared skills automatically, then re-fetches every 10 min so new skills land without a restart. When both yaml skills and card skills are present, the yaml entries take precedence as explicit overrides.

### Long-running tasks

If your agent returns a non-terminal `Task` (state: `submitted` or `working`) instead of an immediate reply, `SkillDispatcherPlugin` hands the task to `TaskTracker` which polls `tasks/get` every 30s (or uses `tasks/resubscribe` for streaming agents). When the task reaches a terminal state, the tracker publishes the response on the original reply topic — the caller sees exactly one response, just later.

For agents that support push notifications (`capabilities.pushNotifications: true` in the card), workstacean registers `PushNotificationConfig` with a per-task HMAC token pointing at `${WORKSTACEAN_BASE_URL}/api/a2a/callback/:taskId`. The agent POSTs Task snapshots to that URL when the state changes, which is faster and cheaper than polling.

### input-required → HITL

When your agent returns `Task.status.state == "input-required"`, the tracker automatically raises a HITL request (Discord approval UI by default). Once a human responds, the tracker resumes the task with `message/send` on the same `taskId` carrying the decision text. No custom `plan_resume` skill is needed — this is the native A2A state machine.

---

## Workstacean as an A2A server

Workstacean itself is an A2A agent too. It exposes:

- `GET /.well-known/agent-card.json` — lists every skill registered in `ExecutorRegistry`
- `POST /a2a` — JSON-RPC 2.0 endpoint (supports `message/send`, `message/stream`, `tasks/*`)

External agents can call workstacean by resolving the card and dispatching skills with a `skillHint` in the message metadata. Auth is the same `WORKSTACEAN_API_KEY` via `Authorization: Bearer <key>` or `X-API-Key`. See [HTTP API reference — POST /a2a](../../reference/http-api#post-a2a) for full details.

---

## Checking registrations

List all registered executors at runtime:

```bash
curl http://localhost:3000/api/agents
```

Returns:

```json
[
  { "name": "ava",        "type": "deep-agent", "skills": ["chat"] },
  { "name": "protomaker", "type": "a2a",       "skills": ["sitrep", "board_health", "manage_feature", "bug_triage"] },
  { "name": "quinn",      "type": "a2a",       "skills": ["pr_review", "bug_triage", "security_triage"] }
]
```

## Related

- [Workspace files reference](../../reference/workspace-files)

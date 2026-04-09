# Add an Agent

protoWorkstacean supports two agent patterns:

- **In-process** — the agent runs inside the workstacean process, powered by `@protolabsai/sdk`. Skills execute as Claude Code SDK sessions with a configurable system prompt and tool whitelist.
- **External A2A** — the agent runs in a separate service (e.g. ava/protoMaker). protoWorkstacean calls it over HTTP using JSON-RPC 2.0. This is the right choice for stateful agents with their own infrastructure.

Both patterns register into `ExecutorRegistry` and are dispatched by `SkillDispatcherPlugin`. From the bus's perspective they are identical — both consume `agent.skill.request` and reply on `agent.skill.response.<correlationId>`.

## Path A: In-process agent

In-process agents are defined in `workspace/agents/<name>.yaml`. `AgentRuntimePlugin` reads all `.yaml` files in that directory at startup and registers a `ProtoSdkExecutor` for each one.

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
    # Environment variable holding the API key. Optional.
    apiKeyEnv: MY_SERVICE_API_KEY
    # Skills this agent handles.
    skills:
      - name: analyze_data
        description: Analyze a dataset and return a summary
      - name: generate_report
        description: Generate a formatted report
    # Bus topics this agent subscribes to directly (informational — not enforced by workstacean).
    subscribesTo:
      - message.inbound.#
```

The `apiKeyEnv` value is the **name** of the environment variable (not the key itself). At request time, `A2AExecutor` reads `process.env[apiKeyEnv]` and sends it as `X-API-Key`.

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

### Skills refreshed from /.well-known/agent.json

You can omit `skills` from `agents.yaml` if your service exposes a `/.well-known/agent.json` discovery endpoint. `SkillBrokerPlugin` will fetch it at startup and register the declared skills automatically.

---

## Checking registrations

List all registered executors at runtime:

```bash
curl http://localhost:3000/api/agents
```

Returns:

```json
[
  { "name": "ava", "type": "proto-sdk", "skills": ["sitrep", "plan"] },
  { "name": "my-service", "type": "a2a", "skills": ["analyze_data", "generate_report"] }
]
```

## Related

- [Executor types reference](../reference/executor-types.md)
- [Explanation: executor layer](../explanation/executor-layer.md)
- [Workspace files reference](../reference/workspace-files.md)

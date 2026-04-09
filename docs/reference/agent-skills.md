---
title: Agent Skills Reference
---

_Skills are the vocabulary of the agent router. Each skill is a named capability that an agent declares. The router matches inbound messages to skills and dispatches accordingly._

---

Skills are declared in `workspace/agents/<name>.yaml` (in-process agents) or `workspace/agents.yaml` (external A2A agents). The `AgentRuntimePlugin` resolves skills from per-agent YAML files first; unknown skills fall through to `SkillBrokerPlugin` for external dispatch.

---

## Skill routing

Skills are matched in priority order:

1. **Explicit hint** — `payload.skillHint` bypasses keyword matching (set by GitHubPlugin, DiscordPlugin, PlanePlugin)
2. **Keyword match** — content scanned against the keyword table in each agent's YAML
3. **Default** — falls back to the agent declared as `default: true` in `agents.yaml`

---

## Defining skills

Each skill entry in an agent's YAML declares:

```yaml
skills:
  - name: my_skill
    description: One-line description used for keyword extraction
    keywords:         # optional — override automatic keyword extraction
      - foo
      - bar
    chain:            # optional — auto-dispatch to another agent after completion
      agent: other-agent
      skill: followup_skill
```

The `description` is used both for human documentation and as the source for automatic keyword extraction at startup.

---

## Adding a new agent

### In-process agent (recommended)

Create `workspace/agents/<name>.yaml`:

```yaml
name: my-agent
role: general                   # orchestrator | qa | devops | content | research | general
model: claude-sonnet-4-6
systemPrompt: |
  You are MyAgent. Your job is...
tools:
  - publish_event
  - get_world_state
maxTurns: 10
skills:
  - name: my_skill
    description: Does the thing
    keywords:
      - the thing
      - do thing
```

`AgentRuntimePlugin` picks up the file on next restart and registers `my_skill` for routing.

Available tools: `publish_event`, `get_world_state`, `get_incidents`, `report_incident`, `get_ceremonies`, `run_ceremony`.

### External A2A agent

1. Add the agent to `workspace/agents.yaml`:

```yaml
agents:
  - name: my-agent
    url: http://my-agent:PORT/a2a
    apiKeyEnv: MY_AGENT_API_KEY
    skills:
      - my_skill
```

2. Restart: `docker restart workstacean`

`SkillBrokerPlugin` dispatches via JSON-RPC 2.0. In-process agents take priority for any skill they declare — external A2A is the fallback.

---

## Skill resolution order

1. **`AgentRuntimePlugin`** — checks `workspace/agents/*.yaml`:
   - Explicit `targets[]` in the request → first matching agent name
   - `skillHint` → first agent declaring that skill
   - No match → falls through
2. **`SkillBrokerPlugin`** — checks `workspace/agents.yaml`:
   - Same resolution order against external A2A agents
   - Timeout: 110s per call

---

## A2A protocol (external agents)

External agent calls use JSON-RPC 2.0 `message/send`:

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "message/send",
  "params": {
    "message": { "role": "user", "parts": [{ "kind": "text", "text": "..." }] },
    "contextId": "workstacean-{channel}"
  }
}
```

Timeout: 120s per agent call. `contextId` is derived from the message channel so conversation context persists across turns.

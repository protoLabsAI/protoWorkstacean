---
title: "Extension: x-protolabsblast-v1"
---

`x-protolabsblast-v1` is an A2A agent card extension that lets skills declare their blast radius — the scope of systems they can affect. The GOAP planner reads these declarations to apply stricter HITL gates to higher-blast skills regardless of goal-level configuration.

**Extension URI**: `https://protolabs.ai/a2a/ext/blast-v1`

---

## Purpose

Without blast radius declarations, the planner cannot distinguish between a skill that only affects the current agent process and one that pushes changes to public systems. When a skill declares its blast radius, the planner can:

- Apply stricter HITL gates to higher-blast skills (e.g. `fleet` or `public`) even when goal-level config would normally allow autonomous execution
- Surface blast context in approval requests so humans can make informed decisions
- Prefer narrower-blast alternatives when multiple skills can achieve the same goal
- Log blast radius alongside execution records for auditing

---

## Blast Radius Levels

Levels are ordered from narrowest to broadest impact:

| Level | Scope | Example |
|-------|-------|---------|
| `self` | Current agent process only | Updating agent-local state |
| `project` | Current project | Updating a Plane ticket |
| `repo` | Repository | Pushing a commit or opening a PR |
| `fleet` | All agents in the fleet | Changing a shared config or restarting agents |
| `public` | External / public systems | Sending an email, posting to Slack, calling an external API |

---

## Schema

Declared inside the A2A agent card under `capabilities.extensions`:

```yaml
capabilities:
  extensions:
    - uri: https://protolabs.ai/a2a/ext/blast-v1
      params:
        skills:
          <skill_name>:
            radius: <self|project|repo|fleet|public>
            description: <optional human-readable description>
```

### Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `radius` | `"self" \| "project" \| "repo" \| "fleet" \| "public"` | yes | Declared blast radius level |
| `description` | `string` | no | Human-readable description of what the skill affects at this radius |

---

## Example

```yaml
capabilities:
  extensions:
    - uri: https://protolabs.ai/a2a/ext/blast-v1
      params:
        skills:
          send_slack_message:
            radius: public
            description: Posts a message to a public Slack channel
          update_ticket_status:
            radius: project
            description: Updates a Plane ticket's status field
          refresh_agent_context:
            radius: self
            description: Clears and reloads the agent's local context cache
```

---

## Runtime data

When an agent executes a skill with blast-v1 support, it includes its blast radius declaration in the terminal artifact's structured data:

```json
{
  "x-blast-radius": {
    "radius": "public",
    "description": "Posts a message to a public Slack channel"
  }
}
```

The extension interceptor reads this from `result.data["x-blast-radius"]` and publishes a `skill.blast.observed` bus event:

```typescript
{
  topic: "skill.blast.observed",
  payload: {
    source: "slack-agent",
    skill: "send_slack_message",
    blast: {
      radius: "public",
      description: "Posts a message to a public Slack channel"
    }
  }
}
```

---

## How the planner uses blast declarations

1. **Pre-dispatch gate** — before selecting a skill for execution, the planner checks its declared blast radius against the active goal's HITL policy.
2. **Escalation threshold** — skills with radius `fleet` or `public` always require HITL approval, even when the goal allows autonomous execution for narrower-blast skills.
3. **Approval context** — the blast radius and description are included in HITL approval requests so humans understand the scope of the proposed action.
4. **Audit trail** — `skill.blast.observed` events are logged with each execution record for compliance and retrospective analysis.

---

## Registering the extension

### In-process agent (workspace/agents/\<name\>.yaml)

Declare blast radius inline under the skill entry:

```yaml
skills:
  - name: send_slack_message
    description: Post a message to a Slack channel
    blast:
      radius: public
      description: Posts a message to a public Slack channel
```

### External A2A agent (agent card)

Add the extension to the agent's `/.well-known/agent-card.json`:

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://protolabs.ai/a2a/ext/blast-v1",
        "params": {
          "skills": {
            "send_slack_message": {
              "radius": "public",
              "description": "Posts a message to a public Slack channel"
            }
          }
        }
      }
    ]
  }
}
```

`SkillBrokerPlugin` reads extensions from the agent card during discovery and merges them into the executor registry.

---

## Versioning

This is version 1 of the blast-radius extension. The URI `https://protolabs.ai/a2a/ext/blast-v1` is stable. Breaking changes (new radius levels, semantic changes to escalation thresholds) will be published under a new versioned URI.

---
title: "Extension: x-protolabsblast-v1"
---

`x-protolabsblast-v1` is an A2A agent card extension that lets skills declare their blast radius — the scope of change a skill can make when it executes. The planner reads these declarations to apply stricter HITL gates to higher-blast skills, independent of goal-level HITL configuration.

**Extension URI**: `https://protolabs.ai/a2a/ext/blast-v1`

---

## Purpose

Without blast radius declarations, the planner has no way to distinguish a skill that writes a note to itself from one that pushes a deployment to an entire fleet. Blast radius declarations let the planner:

- Require human approval for high-blast skills (`fleet`, `public`) regardless of goal-level `hitl` config
- Audit and alert on high-blast skill executions via the `skill.blast.executed` bus topic
- Surface blast scope in the `x-blast-v1-radius` outbound metadata field so agents can confirm they are operating within the expected scope

---

## Blast Radius Values

| Value | Scope |
|-------|-------|
| `self` | Affects only the agent's own state (e.g. internal notes, scratch files) |
| `project` | Affects a single project (e.g. one repo, one Plane project) |
| `repo` | Affects a single repository or workspace (e.g. commits, PRs, branch changes) |
| `fleet` | Affects multiple repositories or services (e.g. cross-repo migrations, fleet restarts) |
| `public` | Visible to or affects external parties (e.g. publishing releases, sending emails, posting to social) |

Blast radii are ordered from least to most impactful: `self` < `project` < `repo` < `fleet` < `public`.

**HITL threshold**: skills with blast radius `fleet` or `public` always require human approval, regardless of goal-level HITL config.

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
            blastRadius: <self | project | repo | fleet | public>
```

### Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `blastRadius` | `string` | yes | One of `self`, `project`, `repo`, `fleet`, `public` |

Each skill declares exactly one blast radius. If a skill does not declare a blast radius, the planner treats it as undeclared and does not apply blast-based HITL gating.

---

## Example

```yaml
capabilities:
  extensions:
    - uri: https://protolabs.ai/a2a/ext/blast-v1
      params:
        skills:
          summarize_notes:
            blastRadius: self
          create_pr:
            blastRadius: repo
          trigger_fleet_restart:
            blastRadius: fleet
          publish_release_notes:
            blastRadius: public
```

In this example, `summarize_notes` and `create_pr` can execute without blast-based gating. `trigger_fleet_restart` and `publish_release_notes` will always trigger a HITL approval request before execution.

---

## Runtime behavior

When the extension interceptor fires for an agent that declares this extension:

### `before()` hook

Stamps outbound metadata with the skill's declared blast radius so the agent and any observing interceptors can see the current execution scope:

```
x-blast-v1-radius: repo
x-blast-v1-requires-hitl: false
```

If no blast radius is declared for the agent+skill, no metadata is stamped.

### `after()` hook

Publishes a `skill.blast.executed` event on the bus:

```typescript
{
  topic: "skill.blast.executed",
  payload: {
    source: "quinn",          // agentName
    skill: "create_pr",       // skill name
    radius: "repo",           // declared blast radius
    requiresHITL: false,      // whether this radius mandates HITL
  }
}
```

This event is used for audit, alerting, and future planner feedback.

---

## How the planner uses blast radius

The planner reads the `x-blast-v1-requires-hitl` metadata field and the `BlastV1Extension.requiresHITL()` utility to gate dispatch:

1. **Pre-dispatch check** — before invoking a skill, the dispatcher calls `getBlastRadius(agentName, skill)`. If the result is `fleet` or `public`, the dispatch is held pending HITL approval.
2. **HITL request** — a `hitl.request.*` event is published with the blast radius as context.
3. **Resumption** — once a human approves, the skill executes normally with the blast radius stamped on metadata.

Blast-based gating applies regardless of whether the active goal's HITL config would otherwise permit autonomous execution.

---

## Registering the extension

### In-process agent (workspace/agents/\<name\>.yaml)

In-process agent YAML does not use the full A2A agent card format. Declare blast radius inline under the skill entry:

```yaml
skills:
  - name: create_pr
    description: Create a pull request
    blastRadius: repo
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
            "create_pr": {
              "blastRadius": "repo"
            },
            "trigger_fleet_restart": {
              "blastRadius": "fleet"
            }
          }
        }
      }
    ]
  }
}
```

`SkillBrokerPlugin` reads extensions from the agent card during discovery and calls `declareBlastRadius()` to register each skill's scope with the extension.

---

## Versioning

This is version 1 of the blast-radius extension. The URI `https://protolabs.ai/a2a/ext/blast-v1` is stable. Breaking changes (new radius values, semantic changes to HITL threshold) will be published under a new versioned URI.

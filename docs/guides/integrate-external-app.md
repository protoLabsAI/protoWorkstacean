---
title: Integrate an External App
---

Connect any external service to the GOAP world engine as a reactive actor. The engine polls the app's health endpoints, evaluates goals against the data, and dispatches actions (alerts or A2A skill calls) when something is wrong.

**Zero code changes per integration.** Everything is declarative YAML + environment variables.

## Overview

An external app integration has four layers:

| Layer | File | Purpose |
|-------|------|---------|
| **Observe** | `workspace/domains.yaml` | Poll the app's HTTP endpoints for state |
| **Evaluate** | `workspace/goals.yaml` | Define what "healthy" looks like |
| **Act** | `workspace/actions.yaml` | Define what to do when unhealthy |
| **Dispatch** | `workspace/agents.yaml` | Register the app's A2A skills for action execution |

The GOAP loop connects them automatically:

```
domains.yaml (poll) → goals.yaml (evaluate) → actions.yaml (match) → agents.yaml (dispatch)
       ↑                                                                        ↓
       └────────────── next tick picks up changes ──────────────────────────────┘
```

## Prerequisites

The external app must expose:

1. **At least one HTTP GET endpoint** returning JSON health/state data
2. **(Optional) An A2A endpoint** (`POST /a2a`) implementing JSON-RPC 2.0 `message/send` for skill dispatch

If the app only has health endpoints and no A2A interface, you can still use it — actions will be limited to alerts and ceremony triggers instead of direct skill dispatch.

## Step 1: Add domains (observe)

Create or append to `workspace/domains.yaml`:

```yaml
domains:
  - name: myapp_health
    url: "${MYAPP_BASE_URL}/api/health"
    tickMs: 60000
    headers:
      X-API-Key: "${MYAPP_API_KEY}"
```

- `name` becomes `domains.myapp_health` in world state
- URL and header values support `${ENV_VAR}` interpolation
- `tickMs` defaults to 60000 (1 minute) if omitted
- The engine automatically sets `extensions.myapp_health_available` to `true`/`false` on each tick

Set the environment variables:

```bash
MYAPP_BASE_URL=http://myapp:8080
MYAPP_API_KEY=your-api-key
```

See [Add a domain](./add-a-domain) for the full schema reference.

## Step 2: Add goals (evaluate)

Append to `workspace/goals.yaml`:

```yaml
  - id: myapp.service_healthy
    type: Invariant
    severity: high
    selector: "domains.myapp_health.data.status"
    operator: eq
    value: "ok"
    description: "MyApp service must report healthy status"
```

The selector path follows the pattern `domains.<name>.data.<field>`. The engine unwraps `{ success, data }` API envelopes automatically, so `data` refers to the inner payload.

Common goal types:

| Type | Use case | Example |
|------|----------|---------|
| **Invariant** | Boolean/enum checks | `status == "ok"`, `connected == true` |
| **Threshold** | Numeric bounds | `errorRate < 0.05`, `agentCount >= 1` |
| **Distribution** | Percentage mix | `featureRatio >= 0.4` |

See [Add goals and actions](./add-goals-and-actions) for all operators and types.

## Step 3: Add actions (act)

Append to `workspace/actions.yaml`. Every action must guard on domain availability:

```yaml
  # Tier 0: alert (free, fire-and-forget)
  - id: alert.myapp_unhealthy
    goalId: myapp.service_healthy
    tier: tier_0
    priority: 10
    cost: 0
    name: "Alert when MyApp is unhealthy"
    preconditions:
      - path: "extensions.myapp_health_available"
        operator: eq
        value: true
      - path: "domains.myapp_health.data.status"
        operator: neq
        value: "ok"
    effects: []
    meta:
      topic: "message.outbound.discord.alert"
      fireAndForget: true

  # Tier 0: dispatch to agent (if A2A is available)
  - id: action.myapp_self_heal
    goalId: myapp.service_healthy
    tier: tier_0
    priority: 20
    cost: 1
    name: "Dispatch MyApp to self-heal"
    preconditions:
      - path: "extensions.myapp_health_available"
        operator: eq
        value: true
      - path: "domains.myapp_health.data.status"
        operator: neq
        value: "ok"
    effects: []
    meta:
      topic: "agent.skill.request"
      skillHint: diagnose
      agentId: myapp
      fireAndForget: true
```

Key fields:
- `preconditions[0]` — **always guard on availability** to avoid firing on stale data
- `meta.topic: "agent.skill.request"` — routes through SkillDispatcher to the A2A executor
- `meta.skillHint` — which skill to invoke on the external agent
- `meta.agentId` — which agent to route to (matches `name` in agents.yaml)
- `meta.fireAndForget: true` — complete immediately (use `false` to wait for outcome)

## Step 4: Register the agent (dispatch)

If the app has an A2A endpoint, create or append to `workspace/agents.yaml`:

```yaml
agents:
  - name: myapp
    url: "${MYAPP_BASE_URL}/a2a"
    apiKeyEnv: MYAPP_API_KEY
    skills:
      - name: diagnose
        description: Run diagnostics and attempt self-healing
      - name: status
        description: Generate a status report
```

- `url` supports `${ENV_VAR}` interpolation
- `apiKeyEnv` is the **name** of the env var (not the value)
- Skills are registered with the `ExecutorRegistry` and become routable via `agent.skill.request`

See [Add an agent](./add-an-agent) for the full A2A schema.

## Step 5: Deploy

Add the environment variables to your deployment config (docker-compose, Infisical, etc.):

```yaml
environment:
  - MYAPP_BASE_URL=${MYAPP_BASE_URL:-}
  - MYAPP_API_KEY=${MYAPP_API_KEY:-}
```

Restart workstacean. Check the logs for:

```
[domain-discovery] global: registered 1 domain(s)
[skill-broker] Registered 1 A2A agent(s)
[world-state-engine] Domain "myapp_health" registered (tick: 60000ms)
```

## Verify

```bash
# Check domain is collecting
curl http://localhost:3000/api/world-state/myapp_health

# Check availability flag
curl http://localhost:3000/api/world-state | jq '.data.extensions.myapp_health_available'

# Check action outcomes (after a goal violation fires)
curl http://localhost:3000/api/outcomes | jq '.recent[] | select(.actionId | startswith("myapp"))'
```

## Reference: Ava integration

The Ava (protoMaker Studio) integration is the canonical example. It demonstrates:

- **Two domains**: `ava_board` (blocked features) and `ava_pipeline` (auto-mode, running agents)
- **Five A2A skills**: sitrep, board_health, auto_mode, manage_feature, bug_triage
- **Two goals**: board health (max 3 blocked) and auto-mode active
- **Three actions**: alert on blocked, dispatch Ava to triage, alert auto-mode off

Files:
- `workspace/domains.yaml` — domain definitions
- `workspace/agents.yaml` — A2A agent registration
- `workspace/goals.yaml` — Ava goals section
- `workspace/actions.yaml` — Ava actions section

## Dispatch flow

```
WorldStateEngine polls domain every tickMs
    ↓
GoalEvaluator detects violation
    ↓
L0 Planner matches action preconditions against world state
    ↓
ActionDispatcher publishes to meta.topic (agent.skill.request)
    ↓
SkillDispatcher extracts skillHint + agentId
    ↓
ExecutorRegistry resolves to A2AExecutor
    ↓
HTTP POST to app's /a2a endpoint (JSON-RPC 2.0)
    ↓
App acts, world state updates on next tick
    ↓
Goal re-evaluates — satisfied → loop quiets
```

If the action fails 3 times within 5 minutes, the `LoopDetector` triggers oscillation cooldown (10 minutes) and escalates to tier_1.

## Related

- [Add a domain](./add-a-domain) — domain schema reference
- [Add an agent](./add-an-agent) — agent YAML and A2A protocol details
- [Add goals and actions](./add-goals-and-actions) — goal types, operators, precondition syntax
- [World Engine concepts](../../explanation/world-engine-concepts) — architecture and design rationale

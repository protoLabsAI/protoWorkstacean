---
title: A2A scheduler bridge
description: Use Workstacean as the scheduler for remote A2A agents like protoAgent forks.
---

Workstacean can act as a shared scheduler for one or more remote A2A agents — useful when you have N [protoAgent](https://github.com/protoLabsAI/protoAgent) forks (e.g. `gina-personal`, `gina-work`) and want a single source of truth for when each one fires its scheduled jobs.

The transport is the `a2a` delivery channel on the [Scheduler](/reference/scheduler/#a2a-delivery-channel). When a schedule with `payload.channel: "a2a"` fires, `A2ADeliveryPlugin` looks up the configured target and POSTs a JSON-RPC `message/send` to that endpoint.

## End-to-end wiring

### 1. Configure the target in Workstacean

Create `workspace/a2a.yaml`:

```yaml
targets:
  gina-personal:
    url: http://gina-personal:7870/a2a
    bearer_token: ${GINA_PERSONAL_BEARER}
```

Restart Workstacean — the plugin logs `[a2a-delivery] Ready — N target(s) configured` on startup.

### 2. Publish a schedule

From any caller (the protoAgent `WorkstaceanScheduler` adapter does this automatically):

```bash
curl -X POST http://localhost:3000/publish \
  -H "X-API-Key: $WORKSTACEAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "command.schedule",
    "payload": {
      "action": "add",
      "id": "gina-personal-daily",
      "schedule": "0 9 * * 1-5",
      "topic": "cron.gina-personal.daily",
      "payload": {
        "content": "morning standup summary",
        "sender": "scheduler",
        "channel": "a2a",
        "agent_name": "gina-personal",
        "scheduler_job_id": "gina-personal-daily"
      }
    }
  }'
```

The four `a2a`-specific fields:

- `channel: "a2a"` — selects the A2A delivery path.
- `agent_name` — keys into `targets` in `workspace/a2a.yaml`.
- `scheduler_job_id` — surfaced as `metadata.scheduler_job_id` so the receiver can distinguish scheduler-driven turns.
- `content` — the user-message text sent to the agent.

### 3. What the receiving agent gets

At fire time, the configured A2A endpoint receives:

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "message/send",
  "params": {
    "message": {
      "messageId": "<uuid>",
      "role": "user",
      "parts": [{ "kind": "text", "text": "morning standup summary" }],
      "metadata": {
        "scheduler_job_id": "gina-personal-daily",
        "channel": "a2a",
        "agent_name": "gina-personal"
      }
    }
  }
}
```

## Topic naming

By convention, scheduled topics are `cron.<agent_name>.<job_id>`. This keeps multi-fork deployments greppable — `bus consumers | grep cron.gina-` shows every job for the `gina-*` agents at a glance.

## Auth

Both `bearer_token` and `api_key` are optional. Configure whichever the target requires (or both):

- `bearer_token` → `Authorization: Bearer <token>`
- `api_key` → `X-API-Key: <key>`

`${ENV_VAR}` substitution is supported in any field, so secrets stay out of the YAML.

## Failure modes

| Scenario | Behavior |
|----------|----------|
| `workspace/a2a.yaml` missing | Plugin installs cleanly with 0 targets. `channel: a2a` firings drop with a loud error. |
| `agent_name` missing on payload | Drops the firing with an error pointing at the topic. |
| `agent_name` not in `targets` | Drops with an error naming the unconfigured agent. |
| HTTP error on POST | Logs the status + body excerpt. The local schedule remains active and re-fires on the next cron tick. |

## Why a separate channel

`signal` and `cli` are *reply* channels — the scheduled fire is processed by a local skill and the *response* routes via the named channel. `a2a` is structurally different: the fired schedule is *delivered* directly to a remote endpoint, no local skill resolution. The router short-circuits when `channel === "a2a"` so the local skill resolver never sees these firings.

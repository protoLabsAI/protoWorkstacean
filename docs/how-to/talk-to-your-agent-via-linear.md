---
title: How to Talk to Your protoAgent via Linear
---

_This is a how-to guide. It gets a [protoAgent](https://github.com/protoLabsAI/protoAgent) fork wired into Workstacean so you can drive it from Linear — write an issue or comment, the agent picks it up, and its reply lands back on the ticket._

---

## What you'll have at the end

A Linear team (or a single ticket) routed to your agent. You write a Linear issue → Workstacean's `LinearPlugin` receives the webhook → `RouterPlugin` dispatches it to your agent over A2A → the agent's reply posts back as a Linear comment. No polling, no glue code per agent.

```
Linear issue/comment
  → /webhooks/linear (LinearPlugin, HMAC-verified)
  → message.inbound.linear.*  (bus)
  → RouterPlugin  (channels.yaml: team → agent)
  → agent.skill.request → A2AExecutor → your agent's /a2a
  → reply → linear.reply.{issueId} → LinearPlugin posts a comment
```

## Before you start

1. **A deployed protoAgent fork** serving its `/a2a` endpoint and an agent card. If you don't have one yet, fork [protoAgent](https://github.com/protoLabsAI/protoAgent) and follow its [first-agent tutorial](https://github.com/protoLabsAI/protoAgent/blob/main/docs/tutorials/first-agent.md) — you need it reachable from Workstacean (same Docker network, Tailscale, or a public URL).
2. **Workstacean's Linear webhook already set up.** If not, do the one-time webhook + secret setup in [the Linear integration reference](../integrations/linear.md#setup) first — that's shared across every agent, you only do it once.
3. **`LINEAR_API_KEY` set on Workstacean** — outbound comments need it. Without it, inbound routing still works but your agent's replies can't post. (See [Posting as the agent](#posting-as-the-agent-vs-as-the-key) below for the identity nuance.)

## 1. Register your agent with Workstacean

Add your agent to `workspace/agents.yaml` so the `SkillBroker` creates an A2A executor for it and discovers its skills from the agent card:

```yaml
agents:
  - name: my-agent                       # routing + logging name
    url: http://my-agent:7870/a2a        # reachable from the Workstacean container
    auth:
      scheme: apiKey
      credentialsEnv: MY_AGENT_API_KEY    # env var NAME, not the secret
    streaming: true
```

No secrets live in this file — only the env var *name*; the value is injected at container start. See [Add an agent](../guides/add-an-agent.md) for the full schema and [Build an A2A agent](../guides/build-an-a2a-agent.md) for the endpoint contract your fork must satisfy.

## 2. Route a Linear team to your agent

Add a channel binding in `workspace/channels.yaml`. `channelId` is the Linear **team key** (e.g. `ENG`) — `LinearPlugin` stamps it as the inbound message's `source.channelId`, and `RouterPlugin` matches it here:

```yaml
channels:
  - id: linear-team-eng
    platform: linear
    channelId: "ENG"          # your Linear team key
    agent: my-agent           # must match the agents.yaml name
    description: ENG team Linear traffic → my-agent
    conversation:
      enabled: true
      timeoutMs: 600000       # 10-min multi-turn window
```

To hand a **single ticket** to the agent instead of a whole team, use the team-prefixed issue identifier as `channelId` (e.g. `ENG-142`) — that entry wins over the team-wide one.

Channels are declarative: no code change, no redeploy of agent logic. `ChannelRegistry` hot-reloads `channels.yaml`.

## 3. Verify the round-trip

1. In Linear, create an issue on the routed team (or comment on the bound ticket).
2. Watch Workstacean's logs — you want:
   ```
   [router] message.inbound.linear.issue.created → skill "chat" … [my-agent]
   [linear] event=issue.created delivered to my-agent (skill=chat)
   ```
3. Within a few seconds, the agent's reply appears as a **comment on the Linear issue**.

If the route matches but no comment lands, check `LINEAR_API_KEY` is set (step 3 of prereqs) and look for a `linear.reply.result.{cid}` with `success: false` in the logs — the plugin surfaces outbound failures (rate limit, empty body, revoked key) rather than swallowing them.

## Posting as the agent vs. as the key

By default, replies post through Workstacean's shared `LINEAR_API_KEY`, so Linear attributes the comment to **whoever owns that key** — the agent signs its text but the author is the key's user. That's fine for most setups.

For the **native experience** — your agent assignable in Linear, responding *as itself* inside Linear's agent-session thread — the agent must be registered as a **Linear OAuth agent app** (`actor=app`) with its own token, not the shared key. That's a per-agent OAuth setup; Ava is the fleet's first agent wired this way. If you want this for your fork, see the agent-identity work in [the Linear integration reference](../integrations/linear.md) rather than the shared-key path above.

## Shortcut: the in-process `proto` agent

If you just want to hand a coding/research task to the fleet's built-in `proto` agent (no fork, no A2A server), label any Linear issue **`proto-task`** — the `linear-proto-bridge` dispatches it to `proto`'s `code.execute` directly. Override the trigger label with `LINEAR_PROTO_BRIDGE_LABEL`. This is the zero-setup path when you don't need your own agent.

## Related

- [Linear integration reference](../integrations/linear.md) — webhook setup, topic contract, env vars
- [Add an agent](../guides/add-an-agent.md) — in-process and A2A registration
- [Build an A2A agent](../guides/build-an-a2a-agent.md) — the endpoint contract a fork must satisfy
- [Linear bridges (architecture)](../architecture/flow-linear-bridges.md) — how label-gated dispatch works under the hood

---
title: Communication Channels
---

Communication channels define how messages flow between external platforms (Discord, GitHub, Signal, Slack) and the agent fleet.

Each channel entry in `workspace/channels.yaml` does three things:

1. **Routes** inbound messages from that platform channel to a specific agent — no keyword matching required
2. **Identifies** the agent — replies come from that agent's own bot identity (its own Discord bot, Slack token, etc.)
3. **Enables** the flow sensor — every message becomes a `flow.item.*` event that FlowMonitorPlugin tracks

---

## channels.yaml schema

```yaml
# workspace/channels.yaml

channels:
  - id: quinn-pr-reviews          # unique ID (used in logs and API)
    platform: discord              # discord | github | linear | signal | slack
    channelId: "1234567890"        # Discord channel ID
    agent: quinn                   # agent that handles this channel
    agentBotTokenEnv: QUINN_DISCORD_TOKEN  # env var for Quinn's bot token
    description: PR review requests

  - id: github-protoWorkstacean
    platform: github
    repo: protoLabsAI/protoWorkstacean
    agent: quinn
```

Copy `workspace/channels.yaml.example` to `workspace/channels.yaml` and edit.

The file hot-reloads every 5 seconds — no restart needed.

---

## Platform setup

### Discord — multiple bot identities

Each Discord channel can have its own bot. When a message arrives, the router looks up the channel in the registry and routes to the assigned agent. Replies come from that agent's own bot account.

**Setup:**

1. Create a Discord application + bot for each agent at [discord.com/developers](https://discord.com/developers/applications)
2. Copy each bot token to an env var: `QUINN_DISCORD_TOKEN`, `AVA_DISCORD_TOKEN`, etc.
3. Add entries to `workspace/channels.yaml`:

```yaml
channels:
  - id: quinn-prs
    platform: discord
    channelId: "YOUR_CHANNEL_ID"   # right-click channel → Copy Channel ID
    agent: quinn
    agentBotTokenEnv: QUINN_DISCORD_TOKEN
```

4. Invite each bot to your server with the `bot` + `applications.commands` scopes

If `agentBotTokenEnv` is not set, the default `DISCORD_BOT_TOKEN` bot handles that channel.

**How it works end-to-end:**

```
User @mentions bot in #pr-reviews
  → DiscordPlugin publishes message.inbound.discord.{channelId}
    → RouterPlugin looks up channelId in ChannelRegistry
      → finds agent: quinn
        → agent.skill.request with targets: ["quinn"]
          → SkillDispatcherPlugin routes to Quinn's executor
            → Quinn replies
              → DiscordPlugin sends reply FROM Quinn's bot client
```

### GitHub

Route @mentions on a specific repository to a specific agent:

```yaml
  - id: github-protoWorkstacean
    platform: github
    repo: protoLabsAI/protoWorkstacean
    agent: quinn
```

When someone @mentions the bot on this repo, RouterPlugin injects `targets: ["quinn"]` into the skill request, bypassing keyword matching.

### Signal

```yaml
  - id: signal-ops
    platform: signal
    groupId: "YOUR_SIGNAL_GROUP_ID"
    agent: ava
    description: Ops escalation channel
```

Requires SignalPlugin to be fully wired (currently a stub — see `lib/plugins/signal.ts`).

### Slack

```yaml
  - id: slack-eng
    platform: slack
    slackChannelId: "C1234567890"
    agentSlackTokenEnv: QUINN_SLACK_TOKEN
    agent: quinn
```

Requires SlackPlugin (not yet implemented).

---

## Adding a channel at runtime

No restart required. Use the API:

```bash
curl -X POST http://localhost:3000/api/channels \
  -H "Content-Type: application/json" \
  -d '{
    "id": "frank-infra",
    "platform": "discord",
    "channelId": "1122334455667788",
    "agent": "frank",
    "agentBotTokenEnv": "FRANK_DISCORD_TOKEN",
    "description": "Infrastructure and deployments"
  }'
```

The entry is written to `workspace/channels.yaml` and the registry reloads within 5 seconds.

List all channels:

```bash
curl http://localhost:3000/api/channels
```

---

## Research sharing across channels

Any agent can publish a `knowledge.shared` event on the bus to share context with other channels:

```typescript
bus.publish("knowledge.shared", {
  id: crypto.randomUUID(),
  correlationId: crypto.randomUUID(),
  topic: "knowledge.shared",
  timestamp: Date.now(),
  payload: {
    source: "quinn",
    content: "PR #123 has a type safety issue in the executor layer",
    tags: ["pr-review", "type-safety"],
    projectSlug: "protoWorkstacean",
  },
});
```

From Discord, use the `/share` slash command (if configured in `workspace/discord.yaml`) or `POST /publish`:

```bash
curl -X POST http://localhost:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "knowledge.shared",
    "payload": {
      "source": "user",
      "content": "The auth refactor is blocked on legal review",
      "tags": ["auth", "blocked"]
    }
  }'
```

Agents subscribed to `knowledge.shared` (via their skill definitions or workspace plugins) receive this context automatically.

---

## How routing priority works

When a message arrives, RouterPlugin resolves the agent in this order:

| Priority | Source | Example |
|---|---|---|
| 1 | `channels.yaml` channel assignment | `channelId: "1234"` → `agent: quinn` |
| 2 | `payload.skillHint` from surface plugin | Discord slash command, Linear webhook |
| 3 | Keyword match from `workspace/agents/*.yaml` | message content contains "review" → quinn |
| 4 | `ROUTER_DEFAULT_SKILL` env var | catch-all for unmatched messages |

Channel assignments always win. If a channel is assigned to Quinn, she gets the message even if the content looks like it belongs to another agent.

---

## Disabled channels

Set `enabled: false` to temporarily disable a channel without removing it:

```yaml
  - id: frank-deployments
    platform: discord
    channelId: "1111222233334444"
    agent: frank
    enabled: false   # Frank is offline — messages fall back to keyword routing
```

# Getting Started with protoWorkstacean

_This is a tutorial. It walks you step-by-step from a fresh clone to your first agent interaction on the bus._

---

## What you'll achieve

By the end of this tutorial you will have:

1. The workstacean container running locally
2. A message published to the bus and routed to an agent
3. A real reply arriving back via the configured output channel

---

## Prerequisites

- Docker + Docker Compose
- Access to Infisical (AI project `11e172e0`) **or** a `.env` file with the required secrets
- A Discord bot token (for Discord output) **or** the ability to read replies from logs

---

## Step 1 — Clone and configure the workspace

```bash
git clone https://github.com/protoLabsAI/protoWorkstacean.git
cd protoWorkstacean
```

The `workspace/` directory is the runtime configuration volume. Deployment-identity
files are gitignored — copy the `.example` files to bootstrap:

```bash
# In-process agent definitions (one file per agent)
cp workspace/agents/ava.yaml.example   workspace/agents/ava.yaml
cp workspace/agents/quinn.yaml.example workspace/agents/quinn.yaml
cp workspace/agents/frank.yaml.example workspace/agents/frank.yaml

# External A2A registry (for remote agents)
cp workspace/agents.yaml.example   workspace/agents.yaml
cp workspace/projects.yaml.example workspace/projects.yaml
cp workspace/discord.yaml.example  workspace/discord.yaml
cp workspace/google.yaml.example   workspace/google.yaml
```

Then fill in your model aliases, system prompts, URLs, and channel IDs. The directory layout:

```
workspace/
  agents/          # in-process agent definitions (one .yaml per agent)  (gitignored)
    ava.yaml       #   Ava — orchestrator
    quinn.yaml     #   Quinn — QA / code review
    frank.yaml     #   Frank — DevOps / CI
  agents.yaml      # external A2A agent registry — URLs, skills, chains  (gitignored)
  projects.yaml    # project registry — repos, Discord channels           (gitignored)
  discord.yaml     # Discord slash commands, channel IDs, moderation      (gitignored)
  google.yaml      # Google Workspace Drive/Calendar/Gmail config         (gitignored)
  incidents.yaml   # live security incident state                         (gitignored)
  actions.yaml     # GOAP action rules                                    (tracked)
  goals.yaml       # GOAP goal definitions                                (tracked)
  ceremonies/      # ceremony YAML files                                  (tracked)
  crons/           # scheduled task YAML files                            (runtime, gitignored)
  plugins/         # hot-loaded workspace plugins
```

---

## Step 2 — Set environment variables

Copy the example env file and fill in the required secrets:

```bash
cp .env.example .env
```

Minimum required secrets to start the server (no plugins enabled):

```
# In-process agent runtime — LLM gateway (LiteLLM Proxy)
LLM_GATEWAY_URL=http://gateway:4000/v1
OPENAI_API_KEY=<gateway-api-key>

# External A2A agents (legacy)
AVA_API_KEY=<key>

# Optional: enable GitHub plugin
GITHUB_TOKEN=<pat>
GITHUB_WEBHOOK_SECRET=<secret>

# Optional: enable Discord plugin
DISCORD_BOT_TOKEN=<token>
DISCORD_GUILD_ID=<guild-id>
```

For the full secret list, see [`docs/reference/config-files.md`](../reference/config-files.md).

---

## Step 3 — Start the container

```bash
docker compose up workstacean
```

Watch the startup log. You should see each plugin report whether it installed successfully:

```
[DiscordPlugin] installed — guild commands registered
[GitHubPlugin] installed — webhook server on :8082
[agent-runtime] Plugin installed — 3 agent(s): ava, quinn, frank | 6 tool(s): publish_event, ...
[skill-broker] Plugin installed — 0 agent(s) registered
[SchedulerPlugin] installed — 0 schedules loaded
```

If a plugin is skipped (missing env var), it logs:
```
[DiscordPlugin] skipped — DISCORD_BOT_TOKEN not set
```

That is expected and safe — the server starts regardless.

---

## Step 4 — Publish your first bus message

The server exposes a `/publish` endpoint on port 3000 (Docker-internal only). From another container on the same network, or using `docker exec`:

```bash
docker exec workstacean curl -s -X POST http://localhost:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "message.inbound.test",
    "payload": {
      "sender": "tutorial",
      "content": "What is the status of the dev board?",
      "channel": "cli",
      "skillHint": "sitrep"
    }
  }'
```

---

## Step 5 — Observe the response

Watch the container logs:

```bash
docker logs -f workstacean
```

You will see:

1. `[A2APlugin] routing message.inbound.test → ava (sitrep)`
2. The A2A call to Ava's `/a2a` endpoint
3. `[A2APlugin] publishing message.outbound.discord.push.<channel>`

If you have a Discord channel configured, the reply appears there. Otherwise it appears in the log output.

---

## Step 6 — Trigger a real workflow via Discord

If the Discord plugin is running:

1. In your Discord server, go to any channel the bot has access to
2. Type `@YourBot` followed by your message, e.g.: `@YourBot sitrep`
3. The bot adds 👀 (processing) then ✅ (done) and replies in-thread

That's it — you've completed your first end-to-end flow:

```
Discord @mention
  → DiscordPlugin → bus (message.inbound.discord.{channelId})
    → A2APlugin → Ava (sitrep skill)
      → Ava responds
        → message.outbound.discord.{channelId}
          → DiscordPlugin posts reply
```

---

## Next steps

| Goal | Where to go |
|------|-------------|
| Onboard a new project | [how-to/onboard-a-project.md](../how-to/onboard-a-project.md) |
| Configure Discord commands | [how-to/configure-discord.md](../how-to/configure-discord.md) |
| Schedule recurring tasks | [how-to/create-a-ceremony.md](../how-to/create-a-ceremony.md) |
| Understand how the bus works | [explanation/architecture.md](../explanation/architecture.md) |
| See all bus topics | [reference/bus-topics.md](../reference/bus-topics.md) |

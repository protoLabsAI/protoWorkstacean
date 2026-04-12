---
title: Getting Started
---

This tutorial walks you through installing protoWorkstacean, writing a minimal workspace configuration, starting the server, and triggering your first skill via the HTTP API.

## Prerequisites

- [Bun](https://bun.sh) >= 1.1
- An Anthropic API key (for in-process agent execution)
- Optional: a running protoMaker team server for A2A routing (board ops, feature lifecycle)

## 1. Clone and install

```bash
git clone https://github.com/protoLabsAI/protoWorkstacean.git
cd protoWorkstacean
bun install
```

## 2. Configure environment

Copy the example env file and fill in the required values:

```bash
cp .env.dist .env
```

Minimum required to start the server with in-process agents:

```dotenv
# In-process agent execution
ANTHROPIC_API_KEY=sk-ant-...

# HTTP port (default 3000)
WORKSTACEAN_HTTP_PORT=3000

# API key protecting the /publish endpoint
WORKSTACEAN_API_KEY=dev-secret

# Workspace config directory
WORKSPACE_DIR=./workspace
```

If you have the protoMaker team server running, add:

```dotenv
# AVA_* env vars describe the HTTP server identity — historical name,
# the logical agent slug in workspace/agents.yaml is `protomaker`.
AVA_BASE_URL=http://localhost:3008
AVA_API_KEY=your-protomaker-team-key
```

For a full list of variables, see [reference/env-vars.md](../../reference/env-vars).

## 3. Bootstrap the workspace

The `workspace/` directory holds all runtime configuration. Start from the bundled examples:

```bash
# In-process agent definitions — ava is the conversational chat agent,
# frank is a chaos-lab experimental persona. Both are optional; start
# with just ava to test the in-process pipeline.
cp workspace/agents/ava.yaml.example   workspace/agents/ava.yaml
cp workspace/agents/frank.yaml.example workspace/agents/frank.yaml

# External A2A agent registry — list the protoMaker team, quinn, etc.
cp workspace/agents.yaml.example workspace/agents.yaml

# Project registry
cp workspace/projects.yaml.example workspace/projects.yaml
```

Edit `workspace/agents/ava.yaml` and set your `systemPrompt`. For a minimal
chat-only Ava:

```yaml
name: ava
role: general
model: claude-sonnet-4-6
systemPrompt: |
  You are Ava, a conversational protoAgent. You answer questions
  and think out loud with the user. You have no tools — when a
  request needs action, suggest which agent is best suited:
  protoMaker team for board ops, Quinn for PR review, Frank for infra.
tools: []
maxTurns: 6
skills:
  - name: chat
    description: Free-form conversation with the user
```

Create minimal stubs for the GOAP files (required at startup):

```bash
echo "goals: []"   > workspace/goals.yaml
echo "actions: []" > workspace/actions.yaml
```

## 4. Start the server

```bash
bun run src/index.ts
```

Startup logs should look like:

```
[agent-runtime] loaded agent: ava (general, 1 skill)
[skill-broker] loaded 0 external agents
[ceremony-plugin] loaded 3 ceremonies
[world-state] domain discovery: 0 domains registered
[http] listening on :3000
[workstacean] ready
```

Confirm health:

```bash
curl http://localhost:3000/health
# {"status":"ok","uptime":3.1}
```

## 5. Trigger your first skill

The `/publish` endpoint injects a message directly onto the bus. This is the same code path that Discord @mentions, GitHub webhooks, and cron events follow.

```bash
curl -X POST http://localhost:3000/publish \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev-secret" \
  -d '{
    "topic": "agent.skill.request",
    "payload": {
      "skill": "sitrep",
      "content": "Give me a quick status summary.",
      "correlationId": "tutorial-001",
      "replyTopic": "agent.skill.response.tutorial-001"
    }
  }'
```

`SkillDispatcherPlugin` picks this up, resolves `sitrep` to the appropriate executor (the protoMaker team's `A2AExecutor` if you wired it, otherwise the dispatcher will log "no executor" and drop the request). For a pure in-process test, change the skill to `chat` — Ava will answer it directly. The result lands on `agent.skill.response.tutorial-001`.

To read the response, query the SQLite event log:

```bash
sqlite3 data/events.db \
  "SELECT payload FROM events WHERE topic LIKE 'agent.skill.response.tutorial-001' ORDER BY ts DESC LIMIT 1;"
```

## 6. Inspect world state

```bash
curl http://localhost:3000/api/world-state
```

With `AVA_BASE_URL` set and domain collectors configured, this returns live JSON from every registered domain.

## Next steps

- [Your first GOAP goal](./first-goap-goal) — automate a reaction to a world-state condition
- [Add an agent](../../guides/add-an-agent) — register in-process or A2A agents
- [Add a domain](../../guides/add-a-domain) — poll custom HTTP endpoints for world state
- [Reference: HTTP API](../../reference/http-api) — all endpoints

---
title: Getting Started
---

This tutorial walks you through installing protoWorkstacean, writing a minimal workspace configuration, starting the server, and triggering your first skill via the HTTP API.

## Prerequisites

- [Bun](https://bun.sh) >= 1.1
- An Anthropic API key (for in-process agent execution)
- Optional: a running ava instance for A2A routing

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

If you have ava running, add:

```dotenv
AVA_BASE_URL=http://localhost:3008
AVA_API_KEY=your-ava-key
```

For a full list of variables, see [reference/env-vars.md](../reference/env-vars.md).

## 3. Bootstrap the workspace

The `workspace/` directory holds all runtime configuration. Start from the bundled examples:

```bash
# In-process agent definitions
cp workspace/agents/ava.yaml.example   workspace/agents/ava.yaml
cp workspace/agents/frank.yaml.example workspace/agents/frank.yaml

# External A2A agent registry (leave empty if not using ava)
cp workspace/agents.yaml.example workspace/agents.yaml

# Project registry
cp workspace/projects.yaml.example workspace/projects.yaml
```

Edit `workspace/agents/ava.yaml` and set your `systemPrompt`. The file looks like:

```yaml
name: ava
role: orchestrator
model: claude-opus-4-6
systemPrompt: |
  You are Ava, the Chief of Staff for protoLabs AI. ...
tools:
  - publish_event
  - get_world_state
maxTurns: 20
skills:
  - name: sitrep
    description: Generate a situational awareness report
    keywords: [status, sitrep, /sitrep]
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
[agent-runtime] loaded agent: ava (orchestrator, 2 skills)
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

`SkillDispatcherPlugin` picks this up, resolves `sitrep` to ava's `ProtoSdkExecutor`, and runs the in-process agent. The result lands on `agent.skill.response.tutorial-001`.

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

- [Your first GOAP goal](./first-goap-goal.md) — automate a reaction to a world-state condition
- [Add an agent](../guides/add-an-agent.md) — register in-process or A2A agents
- [Add a domain](../guides/add-a-domain.md) — poll custom HTTP endpoints for world state
- [Reference: HTTP API](../reference/http-api.md) — all endpoints

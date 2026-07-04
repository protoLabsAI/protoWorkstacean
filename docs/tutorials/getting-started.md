---
title: Getting Started
---

This tutorial walks you through installing protoWorkstacean, writing a minimal workspace configuration, starting the server, and triggering your first skill via the HTTP API.

## Prerequisites

- [Bun](https://bun.sh) >= 1.1
- An Anthropic API key (for in-process agent execution)
- Optional: a reachable remote A2A agent (e.g. protopen) for external skill routing

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

If you have a remote A2A agent (e.g. protopen) reachable, add its base URL and API key — the env var prefix matches the agent's `baseUrlEnv` / `apiKeyEnv` in `workspace/agents.yaml`:

```dotenv
PROTOPEN_BASE_URL=http://steamdeck:7870
PROTOPEN_API_KEY=your-protopen-key
```

For a full list of variables, see [reference/env-vars.md](../reference/env-vars).

## 3. Bootstrap the workspace

The `workspace/` directory holds all runtime configuration. Start from the bundled examples:

```bash
# In-process agent definitions — ava is the conversational chat agent,
# frank is a chaos-lab experimental persona. Both are optional; start
# with just ava to test the in-process pipeline.
cp workspace/agents/ava.yaml.example   workspace/agents/ava.yaml
cp workspace/agents/frank.yaml.example workspace/agents/frank.yaml

# External A2A agent registry — the only live A2A agent is protopen
# (security/pentest, remote). Quinn, proto, and protobot are in-process
# DeepAgents, defined in workspace/agents/, NOT here.
cp workspace/agents.yaml.example workspace/agents.yaml
```

There is no project file to copy — projects come from the **project registry**, not a workspace file. The registry is compiled from repos tagged with the `protoagent-plugin` GitHub topic (plus an explicit base set) into a static `projects.json`, served by the `workstacean-projects` nginx sidecar at `/api/settings/global`. workstacean's `ProjectRegistry` polls that URL (set `PROJECT_REGISTRY_URL`) every 5 min and re-serves the list at `GET /api/projects`. To add a project, tag its repo with the `protoagent-plugin` topic — the 15-min sync cron picks it up.

Edit `workspace/agents/ava.yaml` and set your `systemPrompt`. For a minimal
chat-only Ava:

```yaml
name: ava
role: general
model: protolabs/reasoning
systemPrompt: |
  You are Ava, a conversational protoAgent. You answer questions
  and think out loud with the user. You have no tools — when a
  request needs action, suggest which agent is best suited:
  Quinn (in-process) for PR review, proto (in-process) for code tasks.
tools: []
maxTurns: 6
skills:
  - name: chat
    description: Free-form conversation with the user
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
      "skill": "chat",
      "content": "Give me a quick status summary.",
      "correlationId": "tutorial-001",
      "replyTopic": "agent.skill.response.tutorial-001"
    }
  }'
```

`SkillDispatcherPlugin` picks this up and resolves `chat` to Ava's in-process `DeepAgentExecutor`, which answers it directly. (If you dispatch a skill no registered executor provides, the dispatcher logs "no executor" and drops the request.) The result lands on `agent.skill.response.tutorial-001`.

To read the response, query the SQLite event log:

```bash
sqlite3 data/events.db \
  "SELECT payload FROM events WHERE topic LIKE 'agent.skill.response.tutorial-001' ORDER BY ts DESC LIMIT 1;"
```

## Next steps

- [Add an agent](../guides/add-an-agent) — register in-process or A2A agents
- [Create a ceremony](../guides/create-a-ceremony) — schedule recurring agent work
- [Reference: HTTP API](../reference/http-api) — all endpoints

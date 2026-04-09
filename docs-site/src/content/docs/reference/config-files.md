---
title: Configuration Files Reference
---

# Configuration Files Reference

_This is a reference doc. It covers all `workspace/*.yaml` schemas and environment variables for each plugin._

---

## Environment variables

### Agent Runtime Plugin

| Variable | Required | Description |
|----------|----------|-------------|
| `LLM_GATEWAY_URL` | No | LiteLLM Proxy base URL for all in-process agent LLM calls (default: `http://gateway:4000/v1`) |
| `OPENAI_API_KEY` | Yes (for agents) | Bearer token for the gateway — set to your gateway API key |
| `DISABLE_AGENT_RUNTIME` | No | Set to any value to skip loading `AgentRuntimePlugin` |
| `DISABLE_SKILL_BROKER` | No | Set to any value to skip loading `SkillBrokerPlugin` (use once all agents are migrated in-process) |

### Core / A2A Plugin

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENTS_YAML` | No | Path to external A2A agent registry (default: `/workspace/agents.yaml`) |
| `AVA_API_KEY` | If using external Ava | API key injected as `X-API-Key` header |
| `AVA_APP_ID` | For chain comments | GitHub App ID — chain responses post as `protoava[bot]` |
| `AVA_APP_PRIVATE_KEY` | For chain comments | GitHub App private key (PKCS#1 PEM) |

### GitHub Plugin

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | PAT — enables the plugin; posts comment replies |
| `GITHUB_WEBHOOK_SECRET` | Recommended | Validates `X-Hub-Signature-256` on inbound payloads |
| `GITHUB_WEBHOOK_PORT` | No | Webhook HTTP server port (default: `8082`) |
| `QUINN_APP_ID` | For bot comments | GitHub App ID — Quinn's responses post as `protoquinn[bot]` |
| `QUINN_APP_PRIVATE_KEY` | For bot comments | GitHub App private key (PKCS#1 PEM) |

### Discord Plugin

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Bot token — enables the plugin |
| `DISCORD_GUILD_ID` | Yes | Guild ID for slash command registration |
| `DISCORD_DIGEST_CHANNEL` | No | Fallback channel ID for cron pushes (overridden by `discord.yaml`) |

### Plane Plugin

| Variable | Required | Description |
|----------|----------|-------------|
| `PLANE_WEBHOOK_SECRET` | Yes | HMAC key for webhook signature validation |
| `PLANE_API_KEY` | Yes | For `/api/v1/` reads and writes |
| `PLANE_BASE_URL` | No | Defaults to `http://ava:3002` |
| `PLANE_WORKSPACE_SLUG` | No | Defaults to `protolabsai` |

### Google Plugin

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | Yes | OAuth2 client ID — enables the plugin |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | Yes | Long-lived refresh token |

### Quinn Vector Context Pipeline

| Variable | Required | Description |
|----------|----------|-------------|
| `QDRANT_URL` | Yes (for vector) | `http://qdrant:6333` |
| `QDRANT_VECTOR_SIZE` | No | Embedding dimensions (default: `768`) |
| `OLLAMA_URL` | Yes (for embeddings) | `http://ollama:11434` |
| `OLLAMA_EMBED_MODEL` | No | Embedding model (default: `nomic-embed-text`) |

### Scheduler Plugin

| Variable | Required | Description |
|----------|----------|-------------|
| `TZ` | No | System timezone (e.g., `America/New_York`). Affects default cron timezone. |

---

## Gitignored workspace files

The following files contain deployment-specific config and are not committed to the repo.
Each has a `.example` counterpart — copy it to bootstrap a new deployment:

| File | Copy from |
|------|-----------|
| `workspace/agents/<name>.yaml` | `workspace/agents/<name>.yaml.example` — one file per in-process agent |
| `workspace/agents.yaml` | `workspace/agents.yaml.example` — external A2A agent registry |
| `workspace/projects.yaml` | `workspace/projects.yaml.example` |
| `workspace/discord.yaml` | `workspace/discord.yaml.example` |
| `workspace/google.yaml` | `workspace/google.yaml.example` |
| `workspace/incidents.yaml` | `workspace/incidents.yaml.example` |

Schema/behavior files (`actions.yaml`, `goals.yaml`, `ceremonies/`) are tracked and committed as-is.

---

## workspace/agents/\<name\>.yaml

Per-agent definition for the **in-process** `AgentRuntimePlugin`. One file per agent under `workspace/agents/`. Files ending in `.example` are skipped. All files in this directory are gitignored.

```yaml
name: quinn                         # unique agent key — used in skill routing
role: qa                            # orchestrator | qa | devops | content | research | general

# LLM model alias — resolved by the gateway (LiteLLM Proxy at LLM_GATEWAY_URL)
model: claude-sonnet-4-6

systemPrompt: |
  You are Quinn, the QA Engineer for protoLabs AI.
  ...

# Workstacean bus tools this agent may call.
# Available: publish_event, get_world_state, get_incidents, report_incident,
#            get_ceremonies, run_ceremony
tools:
  - publish_event
  - get_world_state
  - report_incident

# Agents this agent may delegate to (orchestrator role only, DeepAgent pattern)
canDelegate:
  - researcher

# Max agentic turns per invocation (-1 = unlimited, default: 10)
maxTurns: 15

# Skills this agent handles — matched against agent.skill.request skillHint
skills:
  - name: bug_triage
    description: Triage a bug report — severity, root cause, Plane issue
  - name: pr_review
    description: Review a pull request diff
```

**`role`** drives the agent profile and delegation rules:
- `orchestrator` — Ava pattern; can delegate to `canDelegate` agents
- `qa`, `devops`, `content`, `research`, `general` — ReAct subagent; no delegation

**`tools`** is a whitelist — the agent subprocess only sees the tools listed here, plus proto CLI built-ins (file, bash, search).

**`model`** is any alias the LiteLLM gateway recognises. See your gateway config for the full alias list.

---

## workspace/agents.yaml

Source of truth for the **external A2A** agent registry. Used by `SkillBrokerPlugin` to dispatch skills to remote agents over JSON-RPC 2.0. Agents listed here run as separate services (Docker containers or remote hosts).

```yaml
agents:
  - name: ava
    team: dev
    url: http://automaker-server:3008/a2a
    apiKeyEnv: AVA_API_KEY       # env var holding the API key (not the key itself)
    skills:
      - sitrep
      - manage_feature
      - auto_mode
      - board_health
      - onboard_project
      - plan
      - plan_resume

  - name: quinn
    team: dev
    url: http://quinn:7870/a2a
    skills:
      - qa_report
      - board_audit
      - bug_triage
      - pr_review
    chain:
      bug_triage: ava            # after bug_triage, call ava/manage_feature

  - name: frank
    team: dev
    url: http://frank:7880/a2a
    skills:
      - infra_health
      - deploy
      - monitoring
```

**`chain`** is optional. When `chain[skill]` is set, the named agent is called with the first agent's response as context. One level deep only.

> **Migration note:** `workspace/agents/<name>.yaml` (in-process) and `workspace/agents.yaml` (external A2A) coexist. `AgentRuntimePlugin` handles agents it knows about and lets unknown skills fall through to `SkillBrokerPlugin`. Set `DISABLE_SKILL_BROKER=true` once all agents are migrated in-process.

---

## workspace/projects.yaml

Source of truth for the project registry. Consumed by Quinn and protoMaker via `GET /api/projects`. Written to during `onboard_project`.

Webhook URLs are never stored here — use `webhookEnv` to point at an env var holding the URL.

```yaml
projects:
  - slug: your-org-your-repo
    title: Your Project
    github: your-org/your-repo
    defaultBranch: main
    status: active
    agents: [ava, quinn]
    discord:
      dev:
        channelId: ""
        webhookEnv: DISCORD_WEBHOOK_YOURPROJECT_DEV      # env var name, not the URL
      release:
        channelId: ""
        webhookEnv: DISCORD_WEBHOOK_YOURPROJECT_RELEASE
```

---

## workspace/discord.yaml

```yaml
channels:
  digest: ""       # channel ID for cron-triggered posts and message.outbound.discord.push.*
  welcome: ""      # new member welcome messages (blank = disabled)
  modLog: ""       # reserved for future moderation logging

moderation:
  rateLimit:
    maxMessages: 5       # max messages per user per window
    windowSeconds: 10    # rolling window in seconds
  spamPatterns:          # regex strings, case-insensitive, matched messages silently deleted
    - "free\\s*nitro"
    - "discord\\.gift/"

commands:
  - name: mybot
    description: "Bot description shown in Discord"
    subcommands:
      - name: status
        description: "Subcommand description"
        content: "/status"              # text sent as payload.content
        skillHint: qa_report           # optional — routes to specific A2A skill
        options:
          - name: version
            description: "Option description"
            type: string               # string | integer | boolean
            required: false
            autocomplete: false        # true enables live Discord filtering; project options load from projects.yaml
```

---

## workspace/github.yaml

```yaml
mentionHandle: "@quinn"       # case-insensitive handle to watch for

skillHints:
  issue_comment: bug_triage              # comment @mention on issue
  issues: bug_triage                     # new issue body @mention
  pull_request_review_comment: pr_review # review comment @mention
  pull_request: pr_review                # PR body @mention
```

---

## workspace/google.yaml

```yaml
drive:
  orgFolderId: ""             # root org Drive folder ID
  templateFolderId: ""        # per-project template folder ID (optional)

calendar:
  orgCalendarId: ""           # shared org calendar ID (from Google Calendar settings)
  pollIntervalMinutes: 60     # polling interval

gmail:
  watchLabels: []             # Gmail label names to monitor
  pollIntervalMinutes: 5
  routingRules:               # label → skillHint mappings
    - label: "bug-report"
      skillHint: bug_triage
```

---

## workspace/crons/{id}.yaml

```yaml
id: daily-digest              # unique, kebab-case — used as filename
type: cron                    # "cron" or "once" (auto-detected if omitted)
schedule: "0 14 * * *"        # cron expression (recurring) or ISO datetime (one-shot)
timezone: "America/New_York"  # IANA timezone (system default if omitted)
topic: "cron.daily-digest"    # bus topic to publish on fire
payload:
  content: "Generate the daily QA digest"
  sender: "cron"
  channel: "signal"           # reply channel or Discord channel ID
  skillHint: qa_report
enabled: true
lastFired: "2026-04-01T14:00:00.000Z"   # auto-updated by SchedulerPlugin
```

---

## workspace/plugins/{name}.ts

Workspace plugins are TypeScript/JavaScript files exporting a default object implementing the `Plugin` interface. Loaded on container startup. See [`reference/plugins.md`](\1/) for the full interface contract.

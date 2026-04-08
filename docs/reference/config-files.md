# Configuration Files Reference

_This is a reference doc. It covers all `workspace/*.yaml` schemas and environment variables for each plugin._

---

## Environment variables

### Core / A2A Plugin

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENTS_YAML` | No | Path to agent registry (default: `/workspace/agents.yaml`) |
| `AVA_API_KEY` | If using Ava | API key injected as `X-API-Key` header |
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

## workspace/agents.yaml

Source of truth for the agent registry. The A2APlugin fetches `/.well-known/agent.json` from each agent URL on startup and merges live skills.

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

---

## workspace/projects.yaml

Source of truth for the project registry. Consumed by Quinn and protoMaker via `GET /api/projects`. Written to during `onboard_project`.

```yaml
projects:
  - repo: protoLabsAI/my-repo
    plane_project_id: "<uuid>"
    discord:
      dev: "<channel-id>"
      alerts: "<channel-id>"
      releases: "<channel-id>"
    github:
      owner: protoLabsAI
      name: my-repo
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

Workspace plugins are TypeScript/JavaScript files exporting a default object implementing the `Plugin` interface. Loaded on container startup. See [`reference/plugins.md`](plugins.md) for the full interface contract.

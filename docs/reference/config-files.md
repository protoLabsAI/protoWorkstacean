---
title: Configuration Files Reference
---

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
| `AVA_API_KEY` | If using a remote A2A agent | API key injected as the `X-API-Key` header for a remote A2A agent server. |
| `AVA_APP_ID` | For chain comments | GitHub App ID — chain responses post as `@ava[bot]` |
| `AVA_APP_PRIVATE_KEY` | For chain comments | GitHub App private key (PKCS#1 PEM) |

### GitHub Plugin

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | PAT — enables the plugin; posts comment replies |
| `GITHUB_WEBHOOK_SECRET` | Recommended | Validates `X-Hub-Signature-256` on inbound payloads |
| `GITHUB_WEBHOOK_PORT` | No | Webhook HTTP server port (default: `8082`) |
| `GITHUB_APP_ID` | For bot comments | GitHub App ID — Quinn's responses post as `protoquinn[bot]` |
| `GITHUB_APP_PRIVATE_KEY` | For bot comments | GitHub App private key (PKCS#1 PEM) |

### Discord Plugin

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Bot token — enables the plugin |
| `DISCORD_GUILD_ID` | Yes | Guild ID for slash command registration |
| `DISCORD_DIGEST_CHANNEL` | No | Fallback channel ID for cron pushes (overridden by `discord.yaml`) |

### Linear Plugin

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_API_KEY` | For outbound | Personal API key for GraphQL mutations (comment/create/update issues) |
| `LINEAR_WEBHOOK_SECRET` | For inbound | HMAC-SHA256 signing secret from Linear webhook config |
| `LINEAR_WEBHOOK_PORT` | No | Defaults to `8084` |

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
| `EMBED_MODEL` | No | Gateway embedding model (default: `qwen3-embedding`) |
| `LLM_GATEWAY_URL` | No | Gateway base URL (default: `http://gateway:4000/v1`) |

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
| `workspace/discord.yaml` | `workspace/discord.yaml.example` |
| `workspace/google.yaml` | `workspace/google.yaml.example` |
| `workspace/a2a.yaml` | `workspace/a2a.yaml.example` — outbound A2A delivery targets for the scheduler |
| `workspace/incidents.yaml` | `workspace/incidents.yaml.example` |

Behavior files under `ceremonies/` are tracked and committed as-is.

---

## workspace/agents/\<name\>.yaml

Per-agent definition for the **in-process** `AgentRuntimePlugin`. One file per agent under `workspace/agents/`. Files ending in `.example` are skipped. All files in this directory are gitignored.

```yaml
name: quinn                         # unique agent key — used in skill routing
role: qa                            # orchestrator | qa | devops | content | research | general

# LLM model alias — resolved by the gateway (LiteLLM Proxy at LLM_GATEWAY_URL).
# `protolabs/reasoning` is the standard fleet default; concrete names like
# `claude-sonnet-4-6` / `claude-opus-4-7` also work.
model: protolabs/reasoning

systemPrompt: |
  You are Quinn, the QA Engineer for protoLabs AI.
  ...

# Workstacean bus tools this agent may call.
# Available: publish_event, get_projects, get_incidents, report_incident,
#            get_ceremonies, run_ceremony
tools:
  - publish_event
  - get_projects
  - report_incident

# Agents this agent may delegate to (orchestrator role only, DeepAgent pattern)
canDelegate:
  - researcher

# Max agentic turns per invocation (-1 = unlimited, default: 10)
maxTurns: 15

# Skills this agent handles — matched against agent.skill.request skillHint
skills:
  - name: bug_triage
    description: Triage a bug report — severity, root cause, next action
  - name: pr_review
    description: Review a pull request diff
```

**`role`** drives the agent profile and delegation rules:
- `orchestrator` — DeepAgent delegation pattern; can delegate to `canDelegate` agents
- `qa`, `devops`, `content`, `research`, `general` — ReAct subagent; no delegation. Use `general` for conversational agents like the in-process `ava` chat agent.

**`tools`** is a whitelist — the agent subprocess only sees the tools listed here, plus proto CLI built-ins (file, bash, search).

**`model`** is any alias the LiteLLM gateway recognises. See your gateway config for the full alias list.

---

## workspace/fleet.yaml

Maps abstract **roles** to concrete agents — the one file a fork edits to re-skin the fleet without touching code. Loaded by `lib/fleet/fleet-config.ts`; the dispatch/review/remediation paths read these roles instead of hardcoding agent names. All keys default to the proto-labs fleet's values, so an unmodified deploy needs no fleet.yaml.

```yaml
roles:
  helm: ava          # default target for untargeted A2A requests + the OpenAI-compat chat alias
  reviewer: quinn    # runs PR review
github:
  reviewerBotLogins: [protoquinn, "protoquinn[bot]"]   # reviewer's own GitHub identities (review-loop matching)
```

A fork also sets the GitHub App credentials via env: `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (the agent's reviews/comments/issue-closes post as that App's bot).

## workspace/agents.yaml

Source of truth for the **external A2A** agent registry. Used by `SkillBrokerPlugin` to dispatch skills to remote agents over JSON-RPC 2.0. Agents listed here run as separate services (Docker containers or remote hosts).

```yaml
agents:
  # protoPen — security / pentest / RF-recon agent, running remotely.
  - name: protopen
    team: security
    url: http://steamdeck:7870/a2a
    apiKeyEnv: PROTOPEN_API_KEY  # env var holding the API key (not the key itself)
    skills:
      - security_triage
      - pentest
      - rf_recon

  - name: quinn
    team: dev
    url: http://quinn:7870/a2a
    skills:
      - qa_report
      - bug_triage
      - pr_review
      - security_triage

  - name: frank
    team: dev
    url: http://frank:7880/a2a
    skills:
      - infra_health
      - deploy
      - monitoring
```

**`chain`** is optional. When `chain[skill]` is set, the named agent is called with the first agent's response as context. One level deep only.

> **Note:** `workspace/agents/<name>.yaml` (in-process) and `workspace/agents.yaml` (external A2A) coexist. In-process agents like the `ava` chat agent run inside workstacean via `DeepAgentExecutor` (LangGraph); external agents like Quinn and Jon are called via `A2AExecutor`. Both register into the same `ExecutorRegistry`, so skill dispatch is identical from the bus's perspective.

---

## Project metadata (no workspace file)

There is no `workspace/projects.yaml`. The project registry is compiled from GitHub: every repo in the `protoLabsAI` org tagged with the `protoagent-plugin` topic (plus an explicit base set) is assembled by `scripts/sync-project-registry.sh` (in homelab-iac, cron every 15 min) into a static `projects.json`, served by the `workstacean-projects` nginx sidecar at `/api/settings/global`. workstacean's `ProjectRegistry` ([`src/plugins/project-registry.ts`](../../src/plugins/project-registry.ts)) polls that endpoint (URL from `PROJECT_REGISTRY_URL`) every 5 minutes and re-serves the list at `GET /api/projects`. Each entry exposes `id`, `name`, derived `slug`, filesystem `path`, derived `github` (`{ owner, repo }`), and `defaultBranch`.

Discord channel bindings are **not** part of project metadata — they live in `workspace/channels.yaml` via the [ChannelRegistry](workspace-files), keyed by `(projectSlug, kind)` and resolved with `ChannelRegistry.getProjectChannel(slug, kind)`.

To add a project, tag its repo with the `protoagent-plugin` GitHub topic; the 15-min sync cron compiles it into `projects.json` and workstacean picks it up on the next registry refresh (5-min interval, or immediately on restart).

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
            autocomplete: false        # true enables live Discord filtering; project options resolve via the in-process project registry
```

---

## workspace/github.yaml

```yaml
mentionHandle: "@protoquinn"  # case-insensitive handle to watch for

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

## workspace/mcp-servers.d/{name}.yaml

One MCP server per file (ADR-0005): `name`, `trust` (builtin/trusted/community), `transport` (stdio→`command`/`args`/`env`, sse→`url`), optional `grants`, `allowedTools`/`excludeTools`, `enabled`. `McpClientPlugin` connects each enabled server and registers its tools as executors. Managed via the Console / `POST /api/mcp-servers`.

## ~~workspace/plugins/{name}.ts~~ (retired)

The dynamic TS-plugin loader was removed in [ADR-0005](../decisions/0005-mcp-client-tier-and-trust-tiers). First-party plugins live in `lib/plugins/` (compiled in); runtime extension is out-of-process via A2A agents or MCP servers. See [`reference/plugins.md`](plugins).

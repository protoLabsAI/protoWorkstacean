---
title: Environment Variables
---

# Environment Variables

All environment variables recognised by protoWorkstacean, their defaults, and which plugin or subsystem reads them.

## Core / HTTP

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `WORKSTACEAN_HTTP_PORT` | `3000` | HTTP server | Port the HTTP API listens on |
| `WORKSTACEAN_API_KEY` | _(none)_ | HTTP server | API key required for `POST /publish`. If unset, the endpoint rejects all requests. |
| `WORKSPACE_DIR` | `./workspace` | All loaders | Path to the workspace directory containing agent, goal, action, ceremony, and domain YAML files |
| `DATA_DIR` | `./data` | LoggerPlugin, SQLite | Directory for the SQLite event log (`events.db`) |
| `TZ` | system default | SchedulerPlugin | Timezone for cron schedule evaluation |

## Agent runtime (in-process)

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `ANTHROPIC_API_KEY` | _(none)_ | AgentRuntimePlugin / ProtoSdkExecutor | API key for the Anthropic Claude API. Required to run in-process agents. |
| `ROUTER_DEFAULT_SKILL` | _(none)_ | RouterPlugin | Fallback skill name when no keyword match or `skillHint` is found on an inbound message. If unset, unmatched messages are dropped. |
| `DISABLE_ROUTER` | _(none)_ | RouterPlugin | Set to any non-empty value to skip loading RouterPlugin entirely. |

## A2A / ava

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `AVA_BASE_URL` | _(none)_ | WorldStateEngine, SkillBrokerPlugin | Base URL of ava (e.g. `http://ava:3008`). Used for domain URL interpolation and A2A agent registration. |
| `AVA_API_KEY` | _(none)_ | A2AExecutor, WorldStateEngine | API key sent as `X-API-Key` when polling ava domain endpoints or calling ava's `/a2a` endpoint. |

## Discord

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `DISCORD_BOT_TOKEN` | _(none)_ | DiscordPlugin | Discord bot token. If unset, DiscordPlugin is skipped. |
| `DISCORD_GUILD_ID` | _(none)_ | DiscordPlugin | Guild (server) ID for slash command registration. |

Agents can declare their own Discord bot tokens:

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `DISCORD_BOT_TOKEN_AVA` | _(none)_ | DiscordPlugin | Per-agent bot token for ava. Declared via `discordBotTokenEnvKey` in `agents.yaml`. |
| `DISCORD_BOT_TOKEN_QUINN` | _(none)_ | DiscordPlugin | Per-agent bot token for Quinn. |

## GitHub

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `GITHUB_TOKEN` | _(none)_ | GitHubPlugin | Personal access token for GitHub API calls and webhook authentication. If unset and `GITHUB_APP_ID` is also unset, GitHubPlugin is skipped. |
| `GITHUB_WEBHOOK_SECRET` | _(none)_ | GitHubPlugin | HMAC secret for verifying incoming webhook payloads. |
| `GITHUB_APP_ID` | _(none)_ | GitHubPlugin | GitHub App ID (alternative to `GITHUB_TOKEN` for App auth). |
| `GITHUB_APP_PRIVATE_KEY` | _(none)_ | GitHubPlugin | PEM-encoded private key for GitHub App authentication. |
| `GITHUB_APP_INSTALLATION_ID` | _(none)_ | GitHubPlugin | Installation ID for the GitHub App. |

## Optional plugins

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `ENABLED_PLUGINS` | _(none)_ | Plugin loader | Comma-separated list of optional plugin names to enable. Currently: `echo`. Example: `ENABLED_PLUGINS=echo` |

## Domain URL interpolation

Any environment variable can be interpolated into domain URLs and headers in `workspace/domains.yaml` using the `${VAR_NAME}` syntax:

```yaml
domains:
  - name: ava_board
    url: "${AVA_BASE_URL}/api/world/board"
    headers:
      X-API-Key: "${AVA_API_KEY}"
```

This is resolved at poll time, not at startup, so changes to env vars take effect on the next poll cycle.

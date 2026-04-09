---
title: Environment Variables
---

# Environment Variables

All environment variables recognised by protoWorkstacean, their defaults, and which plugin or subsystem reads them.

## Core / HTTP

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `WORKSTACEAN_HTTP_PORT` | `3000` | HTTP server | Port the HTTP API listens on |
| `WORKSTACEAN_API_KEY` | _(none)_ | HTTP server | API key required for authenticated endpoints. If unset, auth is skipped. |
| `WORKSTACEAN_PUBLIC_URL` | _(none)_ | HTTP server | Public base URL (used for webhook registration and self-links) |
| `WORKSPACE_DIR` | `./workspace` | All loaders | Path to the workspace directory containing agent, goal, action, ceremony, and domain YAML files |
| `DATA_DIR` | `./data` | LoggerPlugin, SQLite | Directory for the SQLite event log (`events.db`) |
| `TZ` | system default | SchedulerPlugin | Timezone for cron schedule evaluation |
| `DEBUG` | _(none)_ | All | Set to any value to enable verbose debug logging |
| `DISABLE_EVENT_VIEWER` | _(none)_ | Event viewer | Set to disable the live event viewer UI |

## Agent runtime / LLM gateway

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `LLM_GATEWAY_URL` | `http://gateway:4000/v1` | AgentRuntimePlugin / ProtoSdkExecutor | Base URL for the LiteLLM proxy gateway. All LLM calls route through this. |
| `OPENAI_API_KEY` | _(none)_ | ProtoSdkExecutor | API key sent as Bearer token to the LLM gateway. |
| `OPENAI_BASE_URL` | _(none)_ | ProtoSdkExecutor | Alternative base URL override (takes precedence over `LLM_GATEWAY_URL` if set). |
| `ANTHROPIC_API_KEY` | _(none)_ | AgentRuntimePlugin | Direct Anthropic API key (used when running without a gateway). |
| `ROUTER_DEFAULT_SKILL` | _(none)_ | RouterPlugin | Fallback skill when no keyword match or `skillHint` found. If unset, unmatched messages are dropped. |
| `DISABLE_ROUTER` | _(none)_ | RouterPlugin | Set to any non-empty value to skip RouterPlugin entirely. |

## Observability (LangFuse)

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `LANGFUSE_PUBLIC_KEY` | _(none)_ | ProtoSdkExecutor | LangFuse public key for tracing. If unset, tracing is disabled. |
| `LANGFUSE_SECRET_KEY` | _(none)_ | ProtoSdkExecutor | LangFuse secret key. |
| `LANGFUSE_BASE_URL` | _(none)_ | ProtoSdkExecutor | LangFuse base URL (e.g. `https://cloud.langfuse.com`). |
| `LANGFUSE_HOST` | _(none)_ | ProtoSdkExecutor | Alternative LangFuse host (overrides `LANGFUSE_BASE_URL`). |

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
| `DISCORD_WELCOME_CHANNEL` | _(none)_ | DiscordPlugin | Channel ID for welcome/onboarding messages. |
| `DISCORD_DIGEST_CHANNEL` | _(none)_ | DiscordPlugin | Channel ID for periodic digest posts. |
| `DISCORD_OPS_WEBHOOK_URL` | _(none)_ | DiscordPlugin | Webhook URL for operational alerts. |
| `DISCORD_GOALS_WEBHOOK_URL` | _(none)_ | WorldStateEngine | Webhook URL for goal violation/resolution notifications. |
| `DISCORD_CEREMONY_WEBHOOK_URL` | _(none)_ | CeremonyPlugin | Webhook URL for ceremony run notifications. |
| `DISCORD_BUDGET_WEBHOOK_URL` | _(none)_ | BudgetPlugin | Webhook URL for budget threshold alerts. |
| `DISCORD_WEBHOOK_ALERTS` | _(none)_ | Various | General-purpose alert webhook URL (fallback for plugins without a dedicated webhook var). |

Agents can declare their own Discord bot tokens via `discordBotTokenEnvKey` in `agents.yaml`:

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `DISCORD_BOT_TOKEN_AVA` | _(none)_ | DiscordPlugin | Per-agent bot token for ava. |
| `DISCORD_BOT_TOKEN_QUINN` | _(none)_ | DiscordPlugin | Per-agent bot token for Quinn. |

## GitHub

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `GITHUB_TOKEN` | _(none)_ | GitHubPlugin | Personal access token for GitHub API calls. If unset and `GITHUB_APP_ID` also unset, GitHubPlugin is skipped. |
| `GITHUB_WEBHOOK_SECRET` | _(none)_ | GitHubPlugin | HMAC secret for verifying incoming webhook payloads. |
| `GITHUB_WEBHOOK_PORT` | _(none)_ | GitHubPlugin | Port for the GitHub webhook receiver (if separate from main HTTP port). |
| `GITHUB_APP_ID` | _(none)_ | GitHubPlugin | GitHub App ID (alternative to `GITHUB_TOKEN`). |
| `GITHUB_APP_PRIVATE_KEY` | _(none)_ | GitHubPlugin | PEM-encoded private key for GitHub App authentication. |
| `QUINN_APP_ID` | _(none)_ | GitHubPlugin | App ID for Quinn's dedicated GitHub App installation. |
| `QUINN_APP_PRIVATE_KEY` | _(none)_ | GitHubPlugin | PEM private key for Quinn's GitHub App. |

## Plane

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `PLANE_BASE_URL` | _(none)_ | PlanePlugin | Base URL of the Plane instance (e.g. `https://plane.example.com`). If unset, PlanePlugin is skipped. |
| `PLANE_API_KEY` | _(none)_ | PlanePlugin | Plane API key for issue/project operations. |
| `PLANE_WORKSPACE_SLUG` | _(none)_ | PlanePlugin | Plane workspace slug. |
| `PLANE_WEBHOOK_SECRET` | _(none)_ | PlanePlugin | HMAC secret for verifying Plane webhook payloads. |
| `PLANE_WEBHOOK_PORT` | _(none)_ | PlanePlugin | Port for the Plane webhook receiver. |

## Google Workspace

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `GOOGLE_CLIENT_ID` | _(none)_ | GoogleWorkspacePlugin | OAuth2 client ID. If unset, GoogleWorkspacePlugin is skipped. |
| `GOOGLE_CLIENT_SECRET` | _(none)_ | GoogleWorkspacePlugin | OAuth2 client secret. |
| `GOOGLE_REFRESH_TOKEN` | _(none)_ | GoogleWorkspacePlugin | OAuth2 refresh token for long-lived access. |

## Vector memory (Quinn context)

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `OLLAMA_URL` | _(none)_ | Quinn context | Ollama base URL for local embedding generation. |
| `OLLAMA_EMBED_MODEL` | _(none)_ | Quinn context | Ollama model name for embeddings (e.g. `nomic-embed-text`). |
| `QDRANT_URL` | _(none)_ | Quinn context | Qdrant base URL for vector storage. |
| `QDRANT_VECTOR_SIZE` | _(none)_ | Quinn context | Embedding vector dimensions (must match the embed model). |
| `REDIS_URL` | _(none)_ | Quinn context | Redis URL for caching embeddings or session state. |

## Signal (optional integration)

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `SIGNAL_URL` | _(none)_ | SignalPlugin | Signal API base URL. If unset, SignalPlugin is skipped. |
| `SIGNAL_NUMBER` | _(none)_ | SignalPlugin | Phone number for sending Signal messages. |

## Optional plugins

| Variable | Default | Plugin | Description |
|----------|---------|--------|-------------|
| `ENABLED_PLUGINS` | _(none)_ | Plugin loader | Comma-separated list of optional plugin names to enable. Example: `ENABLED_PLUGINS=echo` |

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

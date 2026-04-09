---
title: Discord Plugin
---

Bridges Discord to the Workstacean bus. @mentions and slash commands become inbound bus messages; agent replies come back as Discord responses.

## How It Works

```
User @mentions Quinn in Discord
  → DiscordPlugin publishes message.inbound.discord.{channelId}
    → RouterPlugin routes to Quinn or Ava based on skillHint / keywords
      → Agent processes, publishes message.outbound.discord.{channelId}
        → DiscordPlugin sends Discord reply (👀 → ✅)

User runs /quinn bugs
  → DiscordPlugin publishes message.inbound.discord.slash.{interactionId}
    → RouterPlugin routes to Quinn (skillHint: bug_triage)
      → Agent replies
        → DiscordPlugin calls interaction.editReply()
```

## Setup

### 1. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Bot token (enables the plugin) |
| `DISCORD_GUILD_ID` | Yes | Guild ID for slash command registration |
| `DISCORD_DIGEST_CHANNEL` | No | Fallback channel ID for cron pushes (overridden by `discord.yaml`) |

The plugin is automatically skipped if `DISCORD_BOT_TOKEN` is not set.

### 2. discord.yaml

Place a `discord.yaml` in your workspace directory (default: `workspace/discord.yaml`). If absent, the plugin loads with empty commands and default moderation settings.

```yaml
# ── Channel IDs ───────────────────────────────────────────────────────────────
channels:
  # Default channel for cron-triggered posts (daily digest, etc.)
  # Falls back to DISCORD_DIGEST_CHANNEL env var if blank.
  digest: "1234567890123456789"
  # Channel for new member welcome messages. Leave blank to disable.
  welcome: ""
  # Channel for moderation log. Leave blank to disable.
  modLog: ""

# ── Moderation ────────────────────────────────────────────────────────────────
moderation:
  rateLimit:
    maxMessages: 5
    windowSeconds: 10
  spamPatterns:
    - "free\\s*nitro"
    - "discord\\.gift/"
    - "@everyone.*https?://"
    - "steamcommunity\\.com/gift"

# ── Slash commands ────────────────────────────────────────────────────────────
# Each command is registered to the guild on startup.
# subcommands[].content supports {optionName} interpolation.
# subcommands[].skillHint routes to a specific A2A skill (optional).
#
# Option types: string | integer | boolean
commands:
  - name: mybot
    description: "My bot — project status and reports"
    subcommands:
      - name: status
        description: "Current project status"
        content: "/status"
        skillHint: qa_report

      - name: report
        description: "Generate a report for a version"
        content: "/report {version}"
        skillHint: qa_report
        options:
          - name: version
            description: "Version tag (e.g. v1.2.0)"
            type: string
            required: false
```

### Fields

#### `channels`

| Field | Description |
|-------|-------------|
| `digest` | Channel ID for `message.outbound.discord.push.*` and cron-triggered posts |
| `welcome` | Channel ID for new member welcome messages |
| `modLog` | Reserved for future moderation logging |

#### `moderation.rateLimit`

| Field | Description |
|-------|-------------|
| `maxMessages` | Max messages per user within the window |
| `windowSeconds` | Rolling window in seconds |

#### `moderation.spamPatterns`

Array of regex strings (escaped for YAML). Matched case-insensitively. Matching messages are silently deleted.

#### `commands[].subcommands[]`

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Subcommand name (lowercase, no spaces) |
| `description` | Yes | Shown in Discord's command picker |
| `content` | Yes | Text sent as the message payload. Use `{optionName}` for interpolation. |
| `skillHint` | No | Tells RouterPlugin which skill to route to |
| `options` | No | Slash command options (see below) |

#### `commands[].subcommands[].options[]`

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Option name — also the interpolation key in `content` |
| `description` | Yes | Shown in Discord |
| `type` | Yes | `string`, `integer`, or `boolean` |
| `required` | No | Defaults to `false` |

### Autocomplete Commands

Commands can use top-level `options` instead of `subcommands` to get Discord's autocomplete UX. Set `autocomplete: true` on any string option to enable live filtering.

When `project` is an autocomplete option, the plugin loads `projects.yaml` and returns matching projects as choices (filtered by slug or title). On submission, the project slug is resolved to `devChannelId` (from `discord.dev`) and `projectRepo` (from the `github` field) and included in the bus payload.

```yaml
commands:
  - name: report-bug
    description: Report a bug against a project
    # Top-level options — no subcommands
    options:
      - name: project
        description: Project to report against (start typing to filter)
        type: string
        required: true
        autocomplete: true
      - name: description
        description: Brief description of the bug
        type: string
        required: true
    content: "Bug report for {project}: {description}"
    skillHint: bug_triage
```

#### `commands[].options[]` (flat/autocomplete commands)

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Option name — also the interpolation key in `content` |
| `description` | Yes | Shown in Discord |
| `type` | Yes | `string`, `integer`, or `boolean` |
| `required` | No | Defaults to `false` |
| `autocomplete` | No | When `true`, Discord sends autocomplete interactions. Only supported on `string` options. For `project` options, choices come from `projects.yaml`. |

#### Flat command bus payload extras

When `project` is resolved from `projects.yaml`, two extra fields are added to the inbound payload:

```typescript
{
  devChannelId?: string;   // discord.dev channel ID for the matched project
  projectRepo?: string;    // GitHub full name (e.g. "protoLabsAI/protoUI")
}
```

## Bus Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `message.inbound.discord.{channelId}` | Inbound | @mention or DM |
| `message.inbound.discord.slash.{interactionId}` | Inbound | Slash command |
| `message.outbound.discord.{channelId}` | Outbound | Reply to @mention or DM |
| `message.outbound.discord.slash.{interactionId}` | Outbound | Reply to slash command |
| `message.outbound.discord.push.{channelId}` | Outbound | Unprompted push (cron, etc.) |

Subscribe to `message.outbound.discord.#` to handle all outbound Discord delivery.

## Inbound Payload

```typescript
{
  sender: string;       // Discord user ID
  channel: string;      // Discord channel ID
  content: string;      // Cleaned message text (mentions stripped)
  skillHint?: string;   // Set by slash commands and 📋 reactions
  isReaction?: boolean; // true when triggered by 📋 reaction
  isThread?: boolean;   // true when message is in a thread
  guildId?: string;     // null for DMs
}
```

## Outbound Payload

```typescript
{
  content: string;    // Reply text (truncated to 2000 chars)
  channel?: string;   // Channel ID for push messages (no correlationId)
}
```

For replies to @mentions and slash commands, match `correlationId` from the inbound message — no `channel` needed.

## Reactions

Reacting to any message with 📋 triggers a `bug_triage` skill request using the message content. Useful for quick bug filing from a chat log.

## Cron Integration

Cron events routed through RouterPlugin that include a `channel` in their payload are delivered to Discord via push:

```yaml
# workspace/crons/daily-digest.yaml
- name: daily-digest
  schedule: "0 14 * * *"
  topic: cron.daily-digest
  payload:
    content: "Generate the daily QA digest"
    skillHint: qa_report
    channel: "1234567890123456789"
```

If `channel` is omitted, the plugin falls back to `channels.digest` from `discord.yaml`, then to `DISCORD_DIGEST_CHANNEL`.

## Discord Bot Permissions

The bot requires the following:

**Scopes:** `bot`, `applications.commands`

**Bot Permissions:**
- Read Messages / View Channels
- Send Messages
- Create Public Threads
- Add Reactions
- Manage Messages (for spam deletion)
- Read Message History
- Manage Guild Members intent (for welcome messages, if used)

**Privileged Gateway Intents** (enable in Discord Developer Portal):
- Message Content Intent
- Server Members Intent (only if using welcome channel)

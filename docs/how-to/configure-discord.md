# How to Configure Discord

_This is a how-to guide. It covers bot setup, `discord.yaml` configuration, slash commands, and autocomplete._

---

## 1. Create and configure the Discord bot

### Bot permissions

In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and add a Bot. Set:

**Scopes:** `bot`, `applications.commands`

**Bot Permissions:**
- Read Messages / View Channels
- Send Messages
- Create Public Threads
- Add Reactions
- Manage Messages (for spam deletion)
- Read Message History
- Manage Guild Members intent (if using welcome channel)

**Privileged Gateway Intents** (enable in the Bot tab):
- Message Content Intent
- Server Members Intent (only if using `channels.welcome`)

### Required environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Bot token — enables the plugin |
| `DISCORD_GUILD_ID` | Yes | Guild ID for slash command registration |
| `DISCORD_DIGEST_CHANNEL` | No | Fallback channel ID for cron pushes |

The plugin is **skipped** if `DISCORD_BOT_TOKEN` is not set.

---

## 2. Configure discord.yaml

Place `discord.yaml` in your workspace directory (default: `workspace/discord.yaml`). If absent, the plugin starts with empty commands and default moderation settings.

```yaml
# workspace/discord.yaml

channels:
  digest: "1234567890123456789"   # channel for cron-triggered posts
  welcome: ""                      # new member welcome messages (leave blank to disable)
  modLog: ""                       # reserved for future moderation logging

moderation:
  rateLimit:
    maxMessages: 5
    windowSeconds: 10
  spamPatterns:
    - "free\\s*nitro"
    - "discord\\.gift/"
    - "@everyone.*https?://"
    - "steamcommunity\\.com/gift"

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

### Channel fields

| Field | Description |
|-------|-------------|
| `digest` | Receives `message.outbound.discord.push.*` and cron-triggered posts |
| `welcome` | New member welcome messages |
| `modLog` | Reserved — not currently active |

### Rate limiting

`rateLimit.maxMessages` and `rateLimit.windowSeconds` define a rolling per-user window. Users exceeding the limit are silently throttled.

### Spam patterns

Array of regex strings (YAML-escaped). Matched case-insensitively. Matching messages are silently deleted.

---

## 3. Define slash commands

### Subcommand style (recommended for multi-action bots)

```yaml
commands:
  - name: dev
    description: "Dev team commands"
    subcommands:
      - name: sitrep
        description: "Current sprint status"
        content: "/sitrep"
        skillHint: sitrep

      - name: audit
        description: "Board audit"
        content: "/audit"
        skillHint: board_audit
```

Users type `/dev sitrep` or `/dev audit`.

### Flat command with autocomplete

Use top-level `options` (no `subcommands`) when you want Discord's autocomplete UX:

```yaml
commands:
  - name: report-bug
    description: Report a bug against a project
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

When `project` is an autocomplete option, the plugin loads `projects.yaml` at interaction time and returns matching projects (filtered by slug or title) as Discord choices.

On submission, the project slug is resolved to `devChannelId` and `projectRepo` which are added to the inbound bus payload:

```typescript
{
  devChannelId?: string;   // discord.dev channel ID from projects.yaml
  projectRepo?: string;    // GitHub full name, e.g. "protoLabsAI/protoUI"
}
```

---

## 4. Reload commands after changes

Slash commands are registered to the guild on container startup. To reload after editing `discord.yaml`:

```bash
docker restart workstacean
```

Changes take effect within a few seconds in Discord (guild-scoped commands update faster than global commands).

---

## Related docs

- [reference/bus-topics.md](../reference/bus-topics.md) — Discord bus topics
- [reference/config-files.md](../reference/config-files.md) — full `discord.yaml` schema reference
- [explanation/plugin-lifecycle.md](../explanation/plugin-lifecycle.md) — how the DiscordPlugin registers and subscribes

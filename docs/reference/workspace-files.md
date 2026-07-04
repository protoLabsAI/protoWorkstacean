---
title: Workspace Files Reference
---

All YAML configuration files in the `workspace/` directory (or the directory pointed to by `WORKSPACE_DIR`). These files are loaded at startup. Most require a restart to pick up changes.

---

## workspace/agents.yaml

External A2A agent registry. Read by `SkillBrokerPlugin`.

```yaml
agents:
  - name: string                    # Unique agent name
    url: string                     # Full A2A endpoint URL
    apiKeyEnv?: string              # Legacy shorthand — env var holding a value sent as X-API-Key
    auth?:                          # Structured auth (Phase 8). Preferred over apiKeyEnv.
      scheme: "apiKey" | "bearer" | "hmac"
      credentialsEnv: string        # Env var holding the credential value
    headers?: Record<string, string> # Static extra request headers (e.g. a2a-extensions opt-in)
    streaming?: boolean             # Whether the agent supports SSE streaming
    discordBotTokenEnvKey?: string  # Optional Discord bot token env var — when set,
                                    # DiscordPlugin's agent pool spins up a dedicated
                                    # Client() for this agent so users can DM it directly
    skills?:                        # Skills to register. Omit to auto-discover from
                                    # /.well-known/agent-card.json (falls back to agent.json).
                                    # Yaml entries take precedence as explicit overrides.
      - name: string
        description?: string
    subscribesTo?:                  # Informational — bus topics this agent watches (not enforced)
      - string
```

**Example**:
```yaml
agents:
  # protoPen — security / pentest / RF-recon agent, running remotely.
  - name: protopen
    url: ${PROTOPEN_BASE_URL}/a2a
    apiKeyEnv: PROTOPEN_API_KEY
    skills:
      - name: security_triage
      - name: pentest
      - name: rf_recon
    subscribesTo:
      - message.inbound.#

  # Quinn — standalone QA engineer.
  - name: quinn
    url: ${QUINN_BASE_URL}/a2a
    skills:
      - name: pr_review
      - name: bug_triage
      - name: security_triage
```

---

## workspace/agents/\<name\>.yaml

In-process agent definition. One file per agent. Read by `AgentRuntimePlugin`.

```yaml
name: string                    # Must be globally unique and match the filename
role: orchestrator | qa | devops | content | research | general
model: string                   # LLM model alias (e.g. "protolabs/reasoning", "claude-sonnet-4-6")
systemPrompt: string            # Full system prompt
tools:                          # Workstacean bus tools this agent may call
  - string                      # publish_event | get_projects | get_incidents |
                                # report_incident | get_ceremonies | run_ceremony
                                # — or [] for a tool-less chat agent
canDelegate?:                   # Agent names this agent may delegate to (2 levels max)
  - string
maxTurns?: number               # Max agentic turns per invocation. -1 = unlimited. Default: 20
discordBotTokenEnvKey?: string  # Optional Discord bot token env var — DiscordPlugin
                                # spins up a dedicated Client so users can DM this
                                # agent's bot directly (same mechanism as the A2A
                                # agent pool)
skills:
  - name: string                # Skill name — matched against agent.skill.request skillHint
    description?: string
    keywords?:                  # Content keywords for auto-routing (case-insensitive substring)
      - string
    systemPromptOverride?: string  # Override system prompt for this specific skill
```

**Example** (in-process conversational agent):
```yaml
# workspace/agents/ava.yaml
name: ava
role: general
model: protolabs/reasoning
systemPrompt: |
  You are Ava, a conversational protoAgent. Your job is to be a
  thoughtful chat partner. You have no tools — when a request needs
  action, suggest which agent or skill is best suited (Quinn for
  reviews, Frank for infra, protoPen for security, etc.).
tools: []                           # No tools on purpose — chat-only
maxTurns: 6
discordBotTokenEnvKey: DISCORD_BOT_TOKEN_AVA
skills:
  - name: chat
    description: Free-form conversation with the user
    keywords: []
```

---

## Project metadata

There is no `workspace/projects.yaml`. Project metadata is compiled from GitHub — every repo in the `protoLabsAI` org tagged with the `protoagent-plugin` topic (plus an explicit base set) is assembled into a static `projects.json` and served by the `workstacean-projects` nginx sidecar at `/api/settings/global`. workstacean's `ProjectRegistry` ([`src/plugins/project-registry.ts`](../../src/plugins/project-registry.ts)) polls that endpoint every 5 minutes and serves the list at `GET /api/projects`. `RouterPlugin` resolves an inbound `owner/repo` to a project (`ProjectRegistry.getByGithub`) and then looks up its Discord channels in `workspace/channels.yaml` via `ChannelRegistry.getProjectChannel(slug, kind)`.

## workspace/channels.yaml

Channel→agent and per-project channel bindings. Read by `ChannelRegistry`. Each entry maps a `(platform, channelId)` to an agent, or binds a `(project, kind)` pair to a Discord channel.

```yaml
channels:
  - id: string             # Unique entry id
    platform: string       # discord | linear | google
    channelId: string      # Platform channel/team/issue id
    agent?: string         # Agent that handles this channel (channel→agent route)
    project?: string       # Project slug — for per-project channel bindings
    kind?: string          # Binding kind (e.g. "dev") for getProjectChannel(slug, kind)
    description?: string
    conversation?:          # Optional multi-turn conversation settings
      enabled: boolean
      timeoutMs: number
      requireMentionAfterFirst?: boolean
```

---

## workspace/ceremonies/\<id\>.yaml

Ceremony definitions. Read by `CeremonyPlugin`. File name (without `.yaml`) must match the `id` field.

```yaml
id: string               # Must match filename
name: string             # Human-readable label
description?: string
schedule: string         # 5-field cron expression (UTC)
skill: string            # Skill name dispatched via agent.skill.request
targets?:                # Agent names for explicit routing. Empty = default routing.
  - string
notifyChannel?: string   # Discord channel ID for delivery. Empty = no Discord post.
enabled?: boolean        # Default: true
```

---

## workspace/mcp-servers.d/

Control-plane-managed MCP servers (ADR-0005), one `McpServerDef` per `.yaml` file. `McpClientPlugin` connects each enabled server and registers its tools as executors live. Managed via the Console / `POST /api/mcp-servers`; trust tiers gate auto-enable.

## ~~workspace/plugins/~~ (retired)

The dynamic TS-plugin loader was removed in [ADR-0005](../decisions/0005-mcp-client-tier-and-trust-tiers) (Node module-cache + workspace module-resolution made it unsafe/broken). First-party plugins live in `lib/plugins/` (compiled in); runtime extension is out-of-process via A2A agents (`agents.d/`) or MCP servers (`mcp-servers.d/`).

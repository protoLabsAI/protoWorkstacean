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
    apiKeyEnv?: string              # Env var name holding the API key
    discordBotTokenEnvKey?: string  # Optional Discord bot token env var — when set,
                                    # DiscordPlugin's agent pool spins up a dedicated
                                    # Client() for this agent so users can DM it directly
    skills?:                        # Skills to register. Omit to use /.well-known/agent.json discovery.
      - name: string
        description?: string
    subscribesTo?:                  # Informational — bus topics this agent watches (not enforced)
      - string
```

**Example**:
```yaml
agents:
  # protoMaker team — multi-agent runtime for board ops, planning, feature lifecycle.
  # Historically called "ava" internally; the env var names keep the AVA_* prefix
  # because they describe the HTTP identity of the protoMaker server, not the
  # logical agent slug.
  - name: protomaker
    url: ${AVA_BASE_URL}/a2a
    apiKeyEnv: AVA_API_KEY
    skills:
      - name: sitrep
      - name: board_health
      - name: manage_feature
      - name: bug_triage
    subscribesTo:
      - message.inbound.#
      - hitl.response.#

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
model: string                   # LLM model alias (e.g. "claude-sonnet-4-6")
systemPrompt: string            # Full system prompt
tools:                          # Workstacean bus tools this agent may call
  - string                      # publish_event | get_world_state | get_incidents |
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
model: claude-sonnet-4-6
systemPrompt: |
  You are Ava, a conversational protoAgent. Your job is to be a
  thoughtful chat partner. You have no tools — when a request needs
  action, suggest which agent or skill is best suited (protoMaker
  team for board ops, Quinn for reviews, Frank for infra, etc.).
tools: []                           # No tools on purpose — chat-only
maxTurns: 6
discordBotTokenEnvKey: DISCORD_BOT_TOKEN_AVA
skills:
  - name: chat
    description: Free-form conversation with the user
    keywords: []
```

---

## workspace/projects.yaml

Project registry. Read by `RouterPlugin` (GitHub enrichment), `GoalEvaluatorPlugin`, and `WorldStateEngine` (per-project domain discovery).

```yaml
projects:
  - slug: string           # Unique project identifier
    owner: string          # GitHub org or user
    repo: string           # GitHub repository name
    workspace?: string     # Path to per-project config dir (relative to WORKSPACE_DIR)
    discordChannels?:      # Discord channel IDs associated with this project
      - string
    planeProjectId?: string  # Plane project ID for issue sync
```

---

## workspace/goals.yaml

Global GOAP goals. Read by `GoalEvaluatorPlugin`. Per-project goals in `workspace/<project>/goals.yaml` are merged at startup.

### Threshold goal

```yaml
goals:
  - id: string             # Unique goal ID — referenced by actions via goalId
    type: Threshold
    severity: low | medium | high | critical
    selector: string       # Dot-path into world state (e.g. "domains.ci.data.successRate")
    min?: number           # Lower bound (inclusive). At least one of min/max required.
    max?: number           # Upper bound (inclusive)
    description?: string
```

### Invariant goal

```yaml
  - id: string
    type: Invariant
    severity: low | medium | high | critical
    selector: string
    operator: truthy | falsy | exists | not_exists
    description?: string
```

### Distribution goal

```yaml
  - id: string
    type: Distribution
    severity: low | medium | high | critical
    description?: string
    distribution:          # Target proportions (0–1). Keys are category names.
      <category>: number
    tolerance?: number     # Allowed deviation. Default: 0.05
```

---

## workspace/actions.yaml

GOAP actions. Read by `ActionRegistry`. Per-project actions in `workspace/<project>/actions.yaml` are merged at startup.

```yaml
actions:
  - id: string             # Unique action ID
    goalId: string         # Goal this action addresses
    tier: tier_0 | tier_1 | tier_2
    priority?: number      # Higher priority wins when multiple actions match. Default: 0
    cost?: number          # A* planning cost. Default: 1
    name?: string          # Human-readable label
    preconditions?:        # All must be true for the action to be selected
      - path: string       # Dot-path into world state
        operator: eq | neq | gt | gte | lt | lte | exists | not_exists
        value?: unknown    # Comparison value (not needed for exists/not_exists)
    effects?:              # World state mutations applied after execution
      - path: string
        type: set | increment | decrement | delete
        value?: unknown
    meta:
      topic: string        # Bus topic ActionDispatcherPlugin publishes when firing this action
      agentId?: string     # Route to a specific agent by name
      fireAndForget?: boolean  # Do not wait for response. Default: false
      payload?: object     # Extra fields merged into the published message
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

## workspace/domains.yaml

Global domain definitions for WorldStateEngine. Per-project domains in `workspace/<project>/domains.yaml` are merged at startup.

```yaml
domains:
  - name: string           # Unique domain name — accessible as domains.<name> in world state
    url: string            # HTTP GET endpoint (JSON response). Supports ${ENV_VAR} interpolation.
    tickMs?: number        # Poll interval in milliseconds. Default: 60000
    headers?:              # HTTP headers. Values support ${ENV_VAR} interpolation.
      <header>: string
```

---

## workspace/plugins/

Directory for hot-loaded workspace plugins. Each `.ts` (or `.js`) file exports a default `Plugin` implementation. Loaded at startup by the plugin loader.

This directory is optional — leave it empty or omit it if you don't need custom plugins.

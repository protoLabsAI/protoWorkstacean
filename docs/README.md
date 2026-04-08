# protoWorkstacean Docs

Documentation for the protoWorkstacean agent orchestration platform, organized using the [Diátaxis](https://diataxis.fr/) framework.

For deployment config (docker-compose, env vars, network setup) see the [homelab-iac repo](https://github.com/protoLabsAI/homelab-iac/blob/main/stacks/ai/docker-compose.yml).

---

## Tutorials — Learning-oriented

Step-by-step guides for getting started. Follow these when you're new to the system.

| Doc | Description |
|-----|-------------|
| [tutorials/getting-started.md](tutorials/getting-started.md) | Install → first plugin running → first onboard |

---

## How-to Guides — Task-oriented

Goal-focused instructions for specific tasks. Use these when you know what you want to do.

| Doc | Description |
|-----|-------------|
| [how-to/onboard-a-project.md](how-to/onboard-a-project.md) | Provision GitHub scaffold, Plane project, and Discord channels for a new repo |
| [how-to/configure-discord.md](how-to/configure-discord.md) | Set up the Discord bot, discord.yaml, slash commands, and autocomplete |
| [how-to/set-up-google-workspace.md](how-to/set-up-google-workspace.md) | Enable Drive, Calendar, and Gmail integration via OAuth2 |
| [how-to/create-a-ceremony.md](how-to/create-a-ceremony.md) | Create recurring scheduled tasks (cron ceremonies) via YAML or the bus |
| [how-to/use-quinn-pr-review.md](how-to/use-quinn-pr-review.md) | Set up GitHub webhooks, configure Quinn's vector context pipeline |

---

## Reference — Information-oriented

Precise technical descriptions of the API contracts and schemas. Use these when you need to look something up.

| Doc | Description |
|-----|-------------|
| [reference/plugins.md](reference/plugins.md) | Plugin interface contract, EventBus API, BusMessage shape, Pi SDK extensions |
| [reference/bus-topics.md](reference/bus-topics.md) | All bus topics across all plugins — publishers, subscribers, payload shapes |
| [reference/agent-skills.md](reference/agent-skills.md) | Full skill registry — agents, keywords, chains, A2A protocol |
| [reference/config-files.md](reference/config-files.md) | All `workspace/*.yaml` schemas and environment variables |

---

## Explanation — Understanding-oriented

Background, concepts, and design rationale. Read these to understand *why* things work the way they do.

| Doc | Description |
|-----|-------------|
| [explanation/architecture.md](explanation/architecture.md) | Bus, plugins, agents — how they connect and the design principles behind them |
| [explanation/plugin-lifecycle.md](explanation/plugin-lifecycle.md) | How plugins register, subscribe, and why hot-reload requires restart |
| [explanation/agent-identity.md](explanation/agent-identity.md) | Multi-bot design, per-agent GitHub App tokens, `contextId` threading |

---

## Legacy flat docs

The original flat docs are preserved as-is for reference and backward-compatible links:

| Doc | Description |
|-----|-------------|
| [a2a.md](a2a.md) | A2A plugin — signal flow diagram, skill routing, chain execution, bus topics |
| [discord.md](discord.md) | Discord plugin — setup, discord.yaml config, slash commands, bus topics |
| [github.md](github.md) | GitHub plugin — webhook setup, github.yaml config, signature validation |
| [hitl.md](hitl.md) | HITL gate — plan/plan_resume flow, HITLRequest/Response types, testing |
| [plane-integration.md](plane-integration.md) | Plane integration — webhook setup, trigger rules, bidirectional sync |
| [scheduler.md](scheduler.md) | Cron scheduler — YAML format, bus commands, missed fire behavior |
| [extensions.md](extensions.md) | Agent extensions — Pi SDK tools vs workspace bus plugins |
| [testing.md](testing.md) | Testing methodology — test scripts, SQLite polling pattern |
| [architecture.md](architecture.md) | Original architecture overview |
| [events.md](events.md) | Event catalog — GoalEvaluatorPlugin events |
| [context-injection.md](context-injection.md) | Quinn's vector context injection detail |

# protoWorkstacean

Homeostatic agent orchestration platform. Monitors world state, evaluates goals, and drives ava's agent fleet to close deviations — continuously and autonomously.

---

## Architecture overview

```
External surfaces (GitHub, Discord, Plane, HTTP)
  → Interface plugins → Event Bus
    → RouterPlugin → agent.skill.request
      → SkillDispatcherPlugin → ExecutorRegistry
        → ProtoSdkExecutor (in-process @protolabsai/sdk)
        → A2AExecutor (HTTP/JSON-RPC 2.0 → ava)

World engine loop (parallel):
  WorldStateEngine (domain pollers)
    → GoalEvaluatorPlugin → world.goal.violated
      → PlannerPluginL0 → world.action.plan
        → ActionDispatcherPlugin → agent.skill.request
```

See [`docs/architecture.md`](docs/architecture.md) for the full picture.

---

## Quick start

```bash
cp .env.dist .env        # fill in keys
bun run src/index.ts
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `WORKSPACE_DIR` | No | Path to workspace dir (default: `./workspace`) |
| `DATA_DIR` | No | SQLite + event log dir (default: `./data`) |
| `DISCORD_BOT_TOKEN` | For Discord | Discord bot token |
| `GITHUB_TOKEN` | For GitHub | PAT for webhook auth and API calls |
| `GITHUB_APP_ID` | For GitHub App auth | App ID |
| `AVA_BASE_URL` | For domain polling | Base URL of ava server (e.g. `http://localhost:3008`) |
| `AVA_API_KEY` | For domain polling | Ava API key (`X-API-Key`) |
| `WORKSTACEAN_HTTP_PORT` | No | HTTP API port (default: `3000`) |
| `WORKSTACEAN_API_KEY` | No | API key for `/publish` endpoint |
| `ANTHROPIC_API_KEY` | For in-process agents | Claude API key |

Full list: see `.env.dist`.

---

## Plugin system

Plugins are loaded in `src/index.ts`. Each implements `install(bus) / uninstall()`.

**Core plugins** (always on):
- `LoggerPlugin` — writes every bus message to `data/events.db`
- `CLIPlugin` — stdin commands
- `SignalPlugin` — SIGTERM/SIGINT graceful shutdown
- `SchedulerPlugin` — cron-style events from `workspace/crons/*.yaml`

**Integration plugins** (condition-gated):

| Plugin | Condition | Role |
|---|---|---|
| `RouterPlugin` | always | Translates inbound messages + cron events → `agent.skill.request` |
| `AgentRuntimePlugin` | always | Registers `ProtoSdkExecutor` per `workspace/agents/*.yaml` into `ExecutorRegistry` |
| `SkillBrokerPlugin` | always | Registers `A2AExecutor` per `workspace/agents.yaml` into `ExecutorRegistry` |
| `SkillDispatcherPlugin` | always | Sole `agent.skill.request` subscriber; dispatches via `ExecutorRegistry` |
| `WorldStateEngine` | always | Generic domain poller; domains registered via `discoverAndRegister()` at startup |
| `GoalEvaluatorPlugin` | always | Evaluates `workspace/goals.yaml` against world state |
| `PlannerPluginL0` | always | Maps violated goals → actions from `ActionRegistry` |
| `ActionDispatcherPlugin` | always | Executes planned actions with WIP limit |
| `CeremonyPlugin` | always | Scheduled fleet rituals from `workspace/ceremonies/*.yaml` |
| `DiscordPlugin` | `DISCORD_BOT_TOKEN` | Discord gateway |
| `GitHubPlugin` | `GITHUB_TOKEN` or `GITHUB_APP_ID` | GitHub webhooks |
| `PlanePlugin` | always | Plane webhook adapter |
| `EchoPlugin` | `ENABLED_PLUGINS=echo` | Test echo |

**Workspace plugins**: drop a `.ts`/`.js` file in `workspace/plugins/` — loaded dynamically at startup.

---

## Executor layer

The executor layer is the unified dispatch path for all agent skill calls.

```
ExecutorRegistry.resolve(skill, targets?)
  1. Named target match — any registration whose agentName is in targets[]
  2. Skill-specific match — sorted by priority desc
  3. Default executor
  4. null → SkillDispatcherPlugin logs and publishes error response
```

**Executor types:**

| Type | Class | When |
|---|---|---|
| `proto-sdk` | `ProtoSdkExecutor` | In-process agents defined in `workspace/agents/*.yaml` |
| `a2a` | `A2AExecutor` | External agents via HTTP/JSON-RPC 2.0 (`workspace/agents.yaml`) |
| `function` | `FunctionExecutor` | Inline functions, used in tests |
| `workflow` | `WorkflowExecutor` | Sequences of bus publishes with optional reply waiting |

See [`docs/executor.md`](docs/executor.md).

---

## World engine

The `WorldStateEngine` is generic — it knows nothing about boards, CI, or agents. Domains are registered at startup via `discoverAndRegister()`:

```
projects.yaml
  → for each projectPath → workspace/domains.yaml
    → engine.registerDomain(name, httpCollector, tickMs)
  → for each projectPath → workspace/actions.yaml
    → actionRegistry.upsert(action)
```

Domain URLs support `${ENV_VAR}` interpolation. ava exposes `/api/world/board` and `/api/world/agent-health` as pollable HTTP endpoints; `workspace/domains.yaml` registers them.

See [`docs/architecture.md`](docs/architecture.md).

---

## Distributed tracing

Every bus message carries `correlationId` (trace-id, never changes) and `parentId` (parent span-id). The `A2AExecutor` forwards both as `X-Correlation-Id` and `X-Parent-Id` HTTP headers. ava echoes the `contextId` back, linking its processing to the originating trace.

---

## Workspace config

| File | Purpose | Tracked |
|---|---|---|
| `workspace/goals.yaml` | GOAP goal definitions | yes |
| `workspace/actions.yaml` | GOAP action rules (workstacean-level) | yes |
| `workspace/ceremonies/*.yaml` | Ceremony schedules + skill routing | yes |
| `workspace/agents/*.yaml` | In-process agent definitions | gitignored |
| `workspace/agents.yaml` | External A2A agent registry | gitignored |
| `workspace/projects.yaml` | Project registry + domain discovery source | gitignored |
| `workspace/domains.yaml` | Local domain registrations (optional) | gitignored |
| `workspace/discord.yaml` | Discord bot config | gitignored |
| `workspace/incidents.yaml` | Live security incident state | gitignored |

Copy `*.example` counterparts to bootstrap a new deployment.

---

## HTTP API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `POST` | `/publish` | Inject a message onto the bus |
| `POST` | `/api/onboard` | Trigger project onboarding pipeline |
| `GET` | `/api/projects` | Project registry |
| `GET` | `/api/agents` | Agent registry |
| `GET` | `/api/world-state` | Current world state snapshot |
| `GET` | `/api/world-state/:domain` | Single domain snapshot |
| `GET` | `/api/ceremonies` | Ceremony definitions |
| `POST` | `/api/ceremonies/:id/run` | Trigger a ceremony manually |
| `GET` | `/api/incidents` | Security incident list |
| `POST` | `/api/incidents` | Report a new incident |
| `POST` | `/api/incidents/:id/resolve` | Resolve an incident |

---

## Testing

```bash
bun test              # all 577 tests
bun test --watch      # watch mode
```

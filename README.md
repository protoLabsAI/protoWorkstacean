# protoWorkstacean

Homeostatic agent orchestration platform. Monitors world state, evaluates goals, and drives the protoLabs agent fleet — **Ava** (chief-of-staff), **protoBot** (Discord infrastructure: channels, categories, webhooks), **Quinn** (QA/PR review), **Researcher** (deep research), **Jon** (content strategy), **protoPen** (security/pentest), plus the protoMaker team — to close deviations continuously and autonomously.

The loop observes skill execution through A2A extensions, writes episodic memory to Graphiti, and ranks future candidates by observed cost/confidence — so the planner gets better the more it runs. See [docs/explanation/self-improving-loop.md](docs/explanation/self-improving-loop.md).

---

## Architecture overview

```
External surfaces (GitHub, Discord, Plane, HTTP)
  → Interface plugins → Event Bus
    → RouterPlugin → agent.skill.request
      → SkillDispatcherPlugin → ExecutorRegistry
        → ProtoSdkExecutor (in-process @protolabsai/sdk)
        → A2AExecutor (HTTP/JSON-RPC 2.0 → protoMaker team / Quinn / protoContent / Frank)

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
| `AVA_BASE_URL` | For domain polling | Base URL of the protoMaker team server (env var name kept for historical reasons; e.g. `http://localhost:3008`) |
| `AVA_API_KEY` | For domain polling | protoMaker team API key (`X-API-Key`) |
| `WORKSTACEAN_HTTP_PORT` | No | HTTP API port (default: `3000`) |
| `WORKSTACEAN_API_KEY` | No | API key for `/publish` endpoint |
| `WORKSTACEAN_BASE_URL` | For A2A push notifications | Externally-reachable URL of the workstacean API (e.g. `http://ava:8081`). Stamped into push-notification callback URLs registered with remote A2A agents that advertise `capabilities.pushNotifications: true`. Unset → silently falls back to task polling. |
| `GRAPHITI_URL` | For memory enrichment | Base URL of the Graphiti knowledge-graph service (default: `http://graphiti:8000`). Skill dispatcher pulls `<recalled_memory>` context before every user-originated skill call and writes episodic memory on success. |
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

Domain URLs support `${ENV_VAR}` interpolation. The protoMaker team server exposes `/api/world/board` and `/api/world/agent-health` as pollable HTTP endpoints; `workspace/domains.yaml` registers them.

See [`docs/architecture.md`](docs/architecture.md).

---

## Distributed tracing

Every bus message carries `correlationId` (trace-id, never changes) and `parentId` (parent span-id). The `A2AExecutor` forwards both as `X-Correlation-Id` and `X-Parent-Id` HTTP headers. External A2A agents echo the `contextId` back, linking their processing to the originating trace.

---

## Workspace config

| File | Purpose | Tracked |
|---|---|---|
| `workspace/goals.yaml` | GOAP goal definitions | yes |
| `workspace/actions.yaml` | GOAP action rules (workstacean-level) | yes |
| `workspace/ceremonies/*.yaml` | Ceremony schedules + skill routing | yes |
| `workspace/agents/*.yaml` | In-process agent definitions (ava, protobot) | yes |
| `workspace/agents.yaml` | External A2A agent registry (quinn, researcher, jon, protopen) | yes |
| `workspace/channels.yaml` | Communication channel registry | yes |
| `workspace/projects.yaml` | Project registry + domain discovery source | gitignored |
| `workspace/domains.yaml` | Local domain registrations (optional) | gitignored |
| `workspace/discord.yaml` | Discord bot config (env var names, channel IDs) | gitignored |
| `workspace/incidents.yaml` | Live security incident state | gitignored |

Agent and channel definitions are shared schema — no secrets live there (only env var *names* for bot tokens and API keys). The actual credentials come from Infisical at container start. Per-environment overrides can ship through `PROTOLABS_AGENTS_JSON` without editing files.

Copy `*.example` counterparts where they exist to bootstrap a new deployment.

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
| `GET` | `/.well-known/agent-card.json` | A2A agent card — discovery for external agents |
| `POST` | `/a2a` | A2A JSON-RPC 2.0 endpoint (message/send, message/stream, tasks/*) |
| `POST` | `/api/a2a/callback/:taskId` | Push-notification webhook for long-running A2A tasks |

Full reference: [`docs/reference/http-api.md`](docs/reference/http-api.md).

---

## A2A protocol support

protoWorkstacean is a first-class [A2A](https://a2a-protocol.org) client **and** server, built on [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk):

- **Client** — `A2AExecutor` speaks the full A2A v0.3 protocol: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`, push notifications, artifact chunking, and native `input-required` HITL.
- **Server** — workstacean exposes `/.well-known/agent-card.json` + `POST /a2a` so external agents can call it. Incoming calls bridge through the bus and back via `BusAgentExecutor`.
- **Auth** — per-agent structured auth config in `workspace/agents.yaml` (apiKey / bearer / hmac schemes).
- **Push notifications** — when a remote agent advertises `capabilities.pushNotifications: true` (e.g. protoPen), the dispatcher registers a webhook at `{WORKSTACEAN_BASE_URL}/api/a2a/callback/{taskId}` with a per-task HMAC-unguessable bearer token. On task state changes the agent POSTs the Task snapshot and the tracker routes it to the original reply topic. Falls back to polling when the agent doesn't advertise push.
- **Extensions** — `ExtensionRegistry` runs before/after interceptors on every A2A call. Shipped by default:
  - [`cost-v1`](docs/extensions/cost-v1.md) — records per-(agent, skill) token + wall-time actuals, publishes `autonomous.cost.*`
  - [`confidence-v1`](docs/extensions/confidence-v1.md) — captures agent-reported confidence (0.0–1.0), flags high-confidence failures
  - [`effect-domain-v1`](docs/extensions/effect-domain-v1.md) — parses worldstate-delta artifacts, publishes `world.state.delta`
  - [`worldstate-delta-v1`](docs/extensions/worldstate-delta-v1.md) — DataPart content type for observed domain mutations

  Observations from cost-v1 + confidence-v1 feed `PlannerPluginL0`'s candidate ranking ([Arc 6.4](docs/explanation/self-improving-loop.md)): once a candidate has ≥5 samples the planner ranks by observed success rate × confidence × wall-time penalty; cold candidates fall back to the card's self-declared confidence.

See [`docs/guides/add-an-agent.md`](docs/guides/add-an-agent.md) for the full agent-onboarding flow.

---

## Testing

```bash
bun test              # all tests
bun test --watch      # watch mode
```

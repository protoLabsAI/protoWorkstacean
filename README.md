# protoWorkstacean

> ## ⚰️ Retired — 2026-07-20
>
> **This project is shut down and this repository is archived.** Nothing runs it any
> more: the container is removed, its 10 GitHub webhooks and both Linear webhooks are
> deleted, its Cloudflare tunnel routes are gone, and its host crons are stripped.
>
> **PR review — the workload this existed to run — is now [Vera](https://github.com/protoLabsAI/qaEngineer),**
> a standalone protoAgent that reviews as `protoreview[bot]` off a GitHub App rather
> than per-repo webhooks. The rest of the fleet (Ava, Jon, Roxy, Frank, Matt) also runs
> as standalone protoAgent containers now, each owning its own triggers. There is no
> central routing hub, and that is deliberate — the hub's remaining job did not justify
> the surface area it carried.
>
> Deployment config for the fleet that replaced it lives in `homelab-iac` (`stacks/*`);
> see `docs/infrastructure/a2a-agent-fleet.md` there for the current topology.
>
> Everything below describes the system as it was, and is kept for history.

**A switchboard for the protoLabs agent ecosystem.** It schedules things, receives events from the outside world (Discord, GitHub, Linear, Google), and routes both into the right agent — wherever that agent lives. Plugins extend its reach to new tools and infrastructure.

That's the whole product. Trigger → router → dispatcher → executor, on a typed event bus.

## What you do with it

- **Reach agents on any machine.** In-process DeepAgent (LangGraph) for things hosted here, A2A (HTTP/JSON-RPC) for agents living elsewhere — same dispatch path.
- **Wire up integrations as plugins.** Discord, GitHub, Linear, Google Workspace ship in `lib/plugins/`. Adding a new one means: emit `message.inbound.*`, subscribe to `message.outbound.*`, register in `src/index.ts`.
- **Schedule recurring work.** Drop yaml into `workspace/crons/` (one-off or cron-shaped) or `workspace/ceremonies/` (named, observable, can also be triggered on-demand).
- **Route by channel.** `workspace/channels.yaml` maps (platform, channelId) → agent. No code changes.

## The fleet

This process hosts a couple of in-process agents and routes to remote ones over A2A:

| Agent | Role | Runtime |
|---|---|---|
| **Ava** | Chief-of-staff orchestrator | In-process (LangGraph) |
| **protoBot** | Discord server operations | In-process (LangGraph) |
| **Quinn** | QA — PR review, bug triage, security triage | In-process (LangGraph) |
| **protoMaker** | Board operations / Automaker | External (A2A) |
| **protoPen** | Security / pentest (Tailscale) | External (A2A) |

In-process agents live in `workspace/agents/*.yaml`. Remote agents live in `workspace/agents.yaml`. Cards advertise capabilities and the dispatcher registers them at startup (and refreshes every 10 minutes).

---

## Architecture

```
External surfaces (Discord, GitHub, Linear, Google) + Cron / Ceremony schedules
   → integration plugin publishes message.inbound.* or cron.* / ceremony.*.execute
     → RouterPlugin (deterministic keyword/channel → skill resolver, no LLM)
       → agent.skill.request
         → SkillDispatcherPlugin (chokepoint for cooldown, target guard,
                                  actor filter, destructive-verdict guard)
           → ExecutorRegistry.resolve(skill, targets)
             ├── DeepAgentExecutor   (Ava, protoBot, Quinn)
             ├── A2AExecutor         (Quinn, protoMaker, Researcher, Jon, protoPen)
             └── FunctionExecutor    (alert.*, ceremony.*, action.pr_*)

Observability (parallel, per A2A call):
   cost-v1, confidence-v1, effect-domain-v1, blast-v1, hitl-mode-v1, langfuse-trace
     → autonomous.cost.*, autonomous.outcome.*
        → AgentFleetHealthPlugin → 24h rollups → health-weighted dispatch
```

See [`docs/architecture.md`](docs/architecture.md).

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
| `WORKSTACEAN_HTTP_PORT` | No | HTTP API port (default: `3000`) |
| `WORKSTACEAN_API_KEY` | No | API key for `/publish` endpoint |
| `WORKSTACEAN_BASE_URL` | For A2A push notifications | Externally-reachable URL of the workstacean API (e.g. `http://workstacean:3000`). Stamped into push-notification callback URLs registered with remote A2A agents that advertise `capabilities.pushNotifications: true`. Unset → silently falls back to task polling. |
| `WORKSTACEAN_PUBLIC_BASE_URL` | For external A2A discovery | Canonical externally-reachable base URL advertised in `/.well-known/agent-card.json`. Sets the card's `url` to `${WORKSTACEAN_PUBLIC_BASE_URL}/a2a`. Unset → card falls back to the internal docker-network URL (see `WORKSTACEAN_INTERNAL_HOST`). |
| `WORKSTACEAN_INTERNAL_HOST` | No | Hostname used in the agent-card fallback URL when `WORKSTACEAN_PUBLIC_BASE_URL` is unset (default: `workstacean`). |
| `ROUTER_DM_DEFAULT_AGENT` | For DM conversations | Agent to route Discord DMs to when no keyword matches (e.g. `quinn`). |
| `ROUTER_DM_DEFAULT_SKILL` | For DM conversations | Skill used for default-routed DMs (default: `chat`). |
| `DM_CONVERSATION_TIMEOUT_MS` | For DM conversations | Idle timeout before a DM session expires (default: `900000` = 15 min). |
| `ANTHROPIC_API_KEY` | For in-process agents | Claude API key (via LiteLLM gateway in production) |

Full list: see `.env.dist`.

---

## Plugin system

Plugins are loaded in `src/index.ts`. Each implements `install(bus) / uninstall()`.

**Core plugins** (always on):
- `LoggerPlugin` — writes every bus message to `data/events.db`
- `CLIPlugin` — stdin commands
- `SignalPlugin` — SIGTERM/SIGINT graceful shutdown
- `SchedulerPlugin` — cron-style events from `workspace/crons/*.yaml`
- `A2ADeliveryPlugin` — cron-triggered A2A deliveries

**Integration plugins** (condition-gated):

| Plugin | Condition | Role |
|---|---|---|
| `RouterPlugin` | always | Translates inbound messages + cron events → `agent.skill.request` |
| `AgentRuntimePlugin` | always | Registers `DeepAgentExecutor` per `workspace/agents/*.yaml` into `ExecutorRegistry` |
| `SkillBrokerPlugin` | always | Registers `A2AExecutor` per `workspace/agents.yaml` into `ExecutorRegistry` |
| `SkillDispatcherPlugin` | always | Sole `agent.skill.request` subscriber; dispatches via `ExecutorRegistry` |
| `AlertSkillExecutorPlugin` | always | Registers `alert.*` FunctionExecutors so any caller can fire a Discord alert by skill name |
| `CeremonySkillExecutorPlugin` | always | Registers `ceremony.*` FunctionExecutors that bridge to `CeremonyPlugin`'s `ceremony.<id>.execute` trigger |
| `PrRemediatorSkillExecutorPlugin` | `QUINN_APP_PRIVATE_KEY` or `GITHUB_TOKEN` | Registers `action.pr_*` FunctionExecutors for PR-remediation skills |
| `CeremonyPlugin` | always | Scheduled fleet rituals from `workspace/ceremonies/*.yaml` |
| `AgentFleetHealthPlugin` | always | Aggregates `autonomous.outcome.#` over a rolling 24h window; feeds health-weighted dispatch in `ExecutorRegistry` |
| `PrRemediatorPlugin` | `QUINN_APP_PRIVATE_KEY` or `GITHUB_TOKEN` | Auto-fix PR remediation flow (rebase, CI diagnose, merge, decompose) |
| `DiscordPlugin` | `DISCORD_BOT_TOKEN` | Discord gateway; multi-bot pool from `channels.yaml`; `ConversationManager` tracks per-user conversation sessions |
| `GitHubPlugin` | `GITHUB_TOKEN` or `GITHUB_APP_ID` | GitHub webhook receiver + outbound API |
| `LinearPlugin` | `LINEAR_API_KEY` or `LINEAR_WEBHOOK_SECRET` | Linear webhook + outbound API |
| `LinearProtoMakerBridgePlugin` | always | Labels Linear issues → protoMaker board features |
| `GooglePlugin` | OAuth triple set | Drive / Docs / Calendar / Gmail outbound + Gmail polling |
| `OperatorRoutingPlugin` | always (pre-installed) | Abstracts operator messaging across transports (Discord DM today) |
| `EventViewerPlugin` | unless `DISABLE_EVENT_VIEWER` | Serves the dashboard event-stream |
| `EchoPlugin` | `ENABLED_PLUGINS=echo` | Test echo |

**Workspace plugins**: drop a `.ts`/`.js` file in `workspace/plugins/` — loaded dynamically at startup.

---

## Executor layer

The executor layer is the unified dispatch path for all agent skill calls.

```
ExecutorRegistry.resolve(skill, targets?)
  1. Named target match — any registration whose agentName is in targets[]
  2. Skill-specific match — sorted by priority desc
     └─ If multiple agents qualify and fleet-health data is available:
        health-weighted random selection
        weight = successRate × (1 / (1 + costPerSuccessfulOutcome))
        New agents with no data get neutral weight 1.0
  3. Default executor
  4. null → SkillDispatcherPlugin logs and publishes error response
```

**Executor types:**

| Type | Class | When |
|---|---|---|
| `deep-agent` | `DeepAgentExecutor` | In-process LangGraph agents defined in `workspace/agents/*.yaml` |
| `a2a` | `A2AExecutor` | External agents via HTTP/JSON-RPC 2.0 (`workspace/agents.yaml`) |
| `function` | `FunctionExecutor` | Inline functions (alert/ceremony/pr_* skills, tests) |
| `workflow` | `WorkflowExecutor` | Sequences of bus publishes with optional reply waiting |

See [`docs/executor.md`](docs/executor.md).

---

## Distributed tracing

Every bus message carries `correlationId` (trace-id, never changes) and `parentId` (parent span-id). The `A2AExecutor` forwards both as `X-Correlation-Id` and `X-Parent-Id` HTTP headers. External A2A agents echo the `contextId` back, linking their processing to the originating trace. When `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` are set, an OTEL tracer registers at startup and DeepAgent calls produce spans in Langfuse.

---

## Workspace config

| File | Purpose | Tracked |
|---|---|---|
| `workspace/agents/*.yaml` | In-process agent definitions (Ava, protoBot, Quinn) | yes |
| `workspace/agents.yaml` | External A2A agent registry (Quinn, Researcher, Jon, protoMaker, protoPen) | yes |
| `workspace/ceremonies/*.yaml` | Ceremony schedules + skill routing | yes |
| `workspace/crons/*.yaml` | Plain cron entries (one-off or recurring) | yes |
| `workspace/channels.yaml` | Communication channel registry (platform + channelId → agent) | yes |
| `workspace/projects.yaml` | Project registry | gitignored |
| `workspace/discord.yaml` | Discord bot config (env var names, channel IDs) | gitignored |
| `workspace/incidents.yaml` | Live security incident state | gitignored |
| `workspace/a2a.yaml` | Per-target A2A delivery config | gitignored |
| `workspace/agent-keys.yaml` | Per-agent API keys (env var refs) | gitignored |

Agent and channel definitions are shared schema — no secrets live there (only env var *names* for bot tokens and API keys). The actual credentials come from Infisical at container start.

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
- **Push notifications** — when a remote agent advertises `capabilities.pushNotifications: true` (e.g. protoPen), the dispatcher registers a webhook at `{WORKSTACEAN_BASE_URL}/api/a2a/callback/{taskId}` with a per-task HMAC-unguessable bearer token. Falls back to polling when the agent doesn't advertise push.
- **Extensions** — `ExtensionRegistry` runs before/after interceptors on every A2A call. Shipped by default:
  - [`cost-v1`](docs/extensions/cost-v1.md) — records per-(agent, skill) token + wall-time actuals, publishes `autonomous.cost.*`
  - [`confidence-v1`](docs/extensions/confidence-v1.md) — captures agent-reported confidence (0.0–1.0), flags high-confidence failures
  - [`effect-domain-v1`](docs/extensions/effect-domain-v1.md) — parses worldstate-delta artifacts (reserved for future consumers)
  - [`blast-v1`](docs/extensions/blast-v1.md) — per-skill scope-of-effect declaration (self/project/repo/fleet/public); HITL policy reads from it
  - [`hitl-mode-v1`](docs/extensions/hitl-mode-v1.md) — per-skill approval policy (autonomous / notification / veto / gated / compound)

Agent authors: see [Build an A2A agent](docs/guides/build-an-a2a-agent.md) for the spec-side recipe and [Extend an A2A agent](docs/guides/extend-an-a2a-agent.md) for the x-protolabs extension pack.

---

## Testing

```bash
bun test              # all tests
bun test --watch      # watch mode
```

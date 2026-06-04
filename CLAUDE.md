# protoWorkstacean — Development Principles

## What this app is

**protoWorkstacean is a switchboard.** It schedules things, receives events from the outside world (Discord, GitHub, Linear, Google), and routes both into the right agent — wherever that agent lives (in-process DeepAgent, remote A2A on another machine, or a function handler). Plugins extend its reach to new tools and infrastructure.

That's the whole product. Nothing else.

## Greenfield. Always.

This codebase has no legacy constraints, no backward compatibility requirements, and no deprecation debt. When changing something, change it completely. Do not:

- Add `@deprecated` shims or wrappers around old APIs
- Keep old function signatures "for compatibility"
- Write migration helpers for callers that don't exist yet
- Add `legacy_*` flags, fallback paths, or version-gated behavior
- Leave dead code with "// removed" or "// replaced by" comments

If an API changes, update every call site. If a concept is replaced, delete the old one. The right amount of code is the minimum that implements the current design — not the current design plus all previous designs.

---

## Architecture

The spine is **trigger → router → dispatcher → executor**, all over a typed event bus.

- **Bus is the contract.** Plugins communicate only through typed bus messages. No plugin holds a direct reference to another.
- **Five trigger surfaces** feed `message.inbound.*` (Discord, GitHub, Linear, Google) or `cron.*` / `ceremony.*.execute` (Scheduler, CeremonyPlugin).
- **RouterPlugin** is a deterministic keyword/channel → skill resolver. No LLM. Turns inbound messages into `agent.skill.request`.
- **SkillDispatcherPlugin** is the sole subscriber to `agent.skill.request`. All chokepoint invariants (cooldown, target-registry guard, synthetic-actor filter, destructive-verdict guard) live here.
- **ExecutorRegistry** maps `(skill, targets)` to an executor. Health-weighted dispatch when fleet metrics are available.
- **Executors are interchangeable.** `DeepAgentExecutor` (in-process LangGraph), `A2AExecutor` (HTTP JSON-RPC), `FunctionExecutor` (alert/ceremony/pr_* skills) — the bus sees no difference.
- **Ceremonies** are recurring fleet rituals: cron + observable outcomes + on-demand triggering. Defined in `workspace/ceremonies/*.yaml`.
- **Channels are declarative.** `workspace/channels.yaml` is the single place to map (platform, channelId) → agent. No code changes needed.

Plugins extend reach: add a new integration → register it in `src/index.ts` → it publishes `message.inbound.*` or subscribes to `message.outbound.*`.

## Git Workflow

**Never push directly to `main`.** All changes flow through:

1. **Feature branch** — branch from `main`, implement, test locally (`bun test`)
2. **PR to `main`** — CI validates, code review, merge → watchtower auto-deploys

Branch naming: `feature/<short-description>` (auto-mode uses Automaker's naming convention).

The Automaker `gitWorkflow.prBaseBranch` is set to `main`. Auto-mode agents target `main` automatically.

The `dev` branch was retired 2026-05-26. Prior to that, feature work targeted `dev` and was promoted to `main` via a release backmerge; that intermediate step was removed because every merge to `main` already auto-deploys via watchtower, and the release ritual is decoupled (manual `auto-release.yml` workflow_dispatch when cutting a version).

### Merge mode

- **One-off PR targeting `main`** → squash-merge (the default).
- **Stacked PR (base is another PR's branch)** → **merge commit**, not squash. Squash rewrites SHAs and breaks subsequent stack rebases. See [`docs/contributing/merge-policy.md`](docs/contributing/merge-policy.md) for the full rationale + rollout steps.
- Local git: `git config --global rebase.updateRefs true` (auto-updates dependent branch refs during rebase).

### Don't enable auto-merge on a moving stack

Auto-merge captures the head SHA when you enable it. If you force-push afterwards (a rebase, an addressed comment), auto-merge fires against the **old** SHA and silently skips your new commits — content gets orphaned. Wait until the stack has stopped moving before clicking auto-merge.

## Stack

- Runtime: Bun
- Language: TypeScript (strict)
- Tests: `bun test` — unit tests against in-memory bus, no mocks, no LLM calls
- Docs: VitePress at `docs/` (config in `docs/.vitepress/`), Diátaxis layout. `cd docs && bun run dev|build`. Sidebar auto-generated per section; matches the fleet docs standard.
- In-process agent runtime: `DeepAgentExecutor` (LangGraph ReAct, LiteLLM-routed Claude calls)
- Remote agent runtime: `A2AExecutor` over HTTP JSON-RPC 2.0

## Key directories

```
src/              Application entry, router, dispatcher, executors, telemetry
src/agent-runtime/    DeepAgentExecutor wiring + agent YAML loader
src/executor/         ExecutorRegistry, SkillDispatcher, A2A/Function/Workflow executors, extensions
src/plugins/          CeremonyPlugin, AgentFleetHealth, alert/ceremony skill executors
src/api/              HTTP routes (per-module)
src/router/           RouterPlugin
lib/plugins/          Integration plugins (Discord, GitHub, Linear, Google, scheduler, HITL, etc.)
lib/channels/         ChannelRegistry — loads workspace/channels.yaml
lib/types/            Shared type definitions
workspace/            Runtime config (channels.yaml, agents/*.yaml, ceremonies/*.yaml, projects.yaml, channels.yaml)
docs/                 Documentation source (Diataxis: tutorials, guides, integrations, reference, explanation)
```

## What this app is NOT

- It is **not** a GOAP system. There is no world-state engine, no goal evaluator, no planner. Earlier versions had one; it was a baroque polling loop and was removed.
- It is **not** an agent itself. It hosts agents (DeepAgent in-process, A2A remote) but the routing and scheduling layer has no agency.
- It is **not** a workflow engine. Ceremonies are scheduled fleet rituals, not orchestrated multi-step workflows.
- It is **not** a memory layer. Episodic memory belongs elsewhere in the stack. The dispatcher routes; it does not enrich.

If you're tempted to add a "world model" or "planner" or "goal" — stop and ask whether a cron or a webhook would do the same job. It almost always will.

---

## Bus topic naming

`<domain>.<noun>.<verb>[.<scope>]` — lowercase, dot-separated, no slashes or colons.

Examples:
- `message.inbound.discord.dm.{userId}` — domain=message, noun=inbound, scope=platform/sub-scope
- `agent.skill.request` — domain=agent, noun=skill, verb=request
- `ceremony.{id}.execute` — domain=ceremony, noun={id}, verb=execute
- `autonomous.outcome.{actor}.{skill}` — domain=autonomous, noun=outcome, scope=actor/skill

Rules:
- Every published topic in production code should appear in `src/event-bus/all-topics.ts`.
- Request/reply pairs suffix correlationId: `<topic>.request.{correlationId}` → `<topic>.response.{correlationId}`.
- Use `#` only as a subscription wildcard suffix (matches any continuation).
- Use `*` only as a single-segment subscription wildcard.

---

## Plugin contract

A plugin implements `Plugin` from `lib/types.ts`:

```ts
{
  name: string;
  description?: string;
  capabilities?: string[];
  install(bus: EventBus): void;
  uninstall(): void;
}
```

**The bus is the contract.** Plugins communicate only through bus publish/subscribe. **Do not hold a reference to another plugin** to call methods on it. If two plugins need to talk, define the topic, publish on it, subscribe on the other side. The startup-time `registrar` pattern (e.g. `AgentRuntimePlugin` populating `ExecutorRegistry`) is the one allowed exemption — it operates on a shared registry object, not another plugin's methods.

---

## Multi-node — decided direction

When we eventually need multiple workstacean nodes (cross-machine fan-out, horizontal scale, durable replay), the answer is **`BusBridgePlugin` to NATS or Redis**, not a replacement for `InMemoryEventBus`.

- Keep `InMemoryEventBus` as the default and only local bus implementation.
- Write a plugin that subscribes to a configured set of topics locally and republishes them to NATS / Redis (or HTTP fan-out to peer nodes), and inversely re-publishes inbound network events onto the local bus.
- Other instances run the same plugin in mirror config.

This preserves the single-node simplicity while making the bus federate when needed. Don't swap the local bus implementation; bridge it.

Stateful executors (DeepAgent instances are in-process and stateful per agent) are NOT magically distributed by this — multi-node federation needs to think about which node "owns" Ava vs which nodes pass messages through. Solve that when we get there.

If the question of multi-node comes up again before this is implemented, the answer is this paragraph.

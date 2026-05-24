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

1. **Feature branch** — branch from `dev`, implement, test locally (`bun test`)
2. **PR to `dev`** — CI validates, code review, merge
3. **PR from `dev` to `main`** — release gate, clean tested code only

Branch naming: `feature/<short-description>` (auto-mode uses Automaker's naming convention).

The Automaker `gitWorkflow.prBaseBranch` is set to `dev`. Auto-mode agents target `dev` automatically.

## Stack

- Runtime: Bun
- Language: TypeScript (strict)
- Tests: `bun test` — unit tests against in-memory bus, no mocks, no LLM calls
- Docs: Astro Starlight at `docs-site/`, source at `docs/` (symlinked)
- In-process agent runtime: `DeepAgentExecutor` (LangGraph ReAct, LiteLLM-routed Claude calls)
- Remote agent runtime: `A2AExecutor` over HTTP JSON-RPC 2.0

## Key directories

```
src/              Application entry, router, dispatcher, executors, telemetry
src/agent-runtime/    DeepAgentExecutor wiring + agent YAML loader
src/executor/         ExecutorRegistry, SkillDispatcher, A2A/Function/Workflow executors, extensions
src/plugins/          CeremonyPlugin, AgentFleetHealth, alert/ceremony/pr-remediator skill executors
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

If you're tempted to add a "world model" or "planner" or "goal" — stop and ask whether a cron or a webhook would do the same job. It almost always will.

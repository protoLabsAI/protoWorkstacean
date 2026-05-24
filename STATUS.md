# protoWorkstacean — Status

## What this app is

A switchboard for the protoLabs agent ecosystem. Triggers (Discord, GitHub, Linear, Google, Cron, Ceremony) feed `message.inbound.*` → RouterPlugin → `agent.skill.request` → SkillDispatcherPlugin → ExecutorRegistry → executor (DeepAgent in-process, A2A remote, or FunctionExecutor for alert/ceremony/pr_* skills).

That's the spine. Everything else extends it.

## Current architecture

- **In-process agents** (DeepAgent / LangGraph): Ava, protoBot, Tuner
- **Remote agents** (A2A): protoMaker, protoPen
- **Integration plugins**: Discord, GitHub, Linear, Google Workspace, linear-protomaker-bridge, pr-remediator
- **Scheduling**: SchedulerPlugin (yaml-defined crons), CeremonyPlugin (named, observable, hot-reloadable rituals)
- **Observability**: AgentFleetHealth (24h rollups → health-weighted dispatch), Langfuse OTEL tracing, cost-v1 / confidence-v1 / blast-v1 / hitl-mode-v1 A2A extensions
- **HITL**: HITLPlugin + ConfigChangeHITLPlugin gate risky actions; OperatorRoutingPlugin abstracts the transport (Discord DM today)

## What's NOT here (and intentionally so)

- No GOAP world-state engine, goal evaluator, or planner. Earlier versions had one; it was a polling loop dressed up as a planner and was removed.
- No two parallel cost systems. The runtime `cost-v1` extension is the one source of truth.
- No ProtoSdk runtime. Replaced entirely by DeepAgent (LangGraph).

## Workflow

`feature → dev → main`. Never push directly to `main`. See [CLAUDE.md](CLAUDE.md) for the principles.

## Where to look

- Read [`README.md`](README.md) for the full architecture map.
- Read [`CLAUDE.md`](CLAUDE.md) for the development principles.
- Read [`docs/architecture.md`](docs/architecture.md) for diagrams.
- For agent-side recipes, see `docs/guides/build-an-a2a-agent.md` and `docs/guides/extend-an-a2a-agent.md`.

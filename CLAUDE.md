# protoWorkstacean — Development Principles

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

- **Bus is the contract.** Plugins communicate only through typed bus messages. No plugin holds a direct reference to another.
- **Executors are interchangeable.** `ProtoSdkExecutor` (in-process), `A2AExecutor` (HTTP JSON-RPC), future runtimes — the bus sees no difference.
- **World state is ground truth.** The GOAP loop polls durable HTTP domains, builds a world state snapshot, and evaluates declarative goals against it.
- **Channels are declarative.** `workspace/channels.yaml` is the single place to add a communication channel. No code changes needed.

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
- Agent runtime: `@protolabsai/sdk` (in-process) or A2A JSON-RPC 2.0

## Key directories

```
src/              Application entry + runtime plugins (RouterPlugin, SkillDispatcherPlugin, etc.)
lib/plugins/      Integration plugins (Discord, GitHub, Plane, FlowMonitor, HITL, etc.)
lib/channels/     ChannelRegistry — loads workspace/channels.yaml
lib/types/        Shared type definitions
workspace/        Runtime config (goals.yaml, actions.yaml, channels.yaml, agents/*.yaml)
docs/             Documentation source (Diataxis: tutorials, guides, integrations, reference, explanation)
```

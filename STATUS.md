# protoWorkstacean — Session Status (Apr 7–8, 2026)

Handoff doc for the team. Covers everything done in today's session.

## What Was Shipped

### Milestone 1 (already on main before today)
- Per-agent Discord bot identity (multi-bot client pool)
- MemoryPlugin (mem0 self-hosted API)
- agents.yaml fixes (port conflicts, endpoint mismatches, chain rules)

### Milestone 2 + 3 (merged to main today via #27 → then individual PRs)

| PR | What |
|----|------|
| #29 | OnboardingPlugin docs — reference + how-to (M1/M2/M3) |
| #30 | World Engine docs — reference + explanation (GOAP-Flow homeostatic system) |
| #31 | Quinn docs — reference (PR review bot + vector context) |
| #32 | CeremonyPlugin docs — reference + how-to (YAML-defined recurring fleet rituals) |
| #33 | Google Workspace Plugin docs — reference + how-to |
| #34 | OnboardingPlugin unit tests — all 9 pipeline steps + idempotency (timeout fixed: 100ms → 500ms) |
| #35 | Wire `world.goal.violated` → L0 planner cascade + register CeremonyPlugin + FlowMonitorPlugin in `src/index.ts` |
| #36 | World Engine extension guide — how to add state, goals, actions, plugins |
| #37 | project-schema.ts Zod validation tests |
| #38 | CeremonyPlugin: SQLite outcomes DB opened with WAL mode (was missing, caused concurrency issues) |
| #39 | Discord autocomplete + GitHub org webhook handler tests (M2) |
| #40 | Discord rate limiter persistence (was in-process only, state lost on restart) |
| #41 | Fix: `projects.yaml` file watcher was firing 14+ times per change — added debounce |
| #42 | Fix: `plane-hitl` showed 0 projects — Discord channel key mismatch vs `projects.yaml` schema |
| #43 | Fix: no circuit breaker on external API calls — Google/Plane/GitHub would spam retries on outage |

## Current State

- **Branch**: `main` is the active branch for all feature work
  - `prBaseBranch` changed from `dev` → `main` in `.automaker/settings.json` (fixes squash-merge divergence that was blocking worktrees)
- **Container**: running from `main`, up ~43 min, all Discord bots connected (ava, quinn, frank, jon)
- **Board**: 0 backlog, 0 in-progress, 0 in review, 16 done
- **Bug in progress**: `escalations.json` corrupt JSON crashes EscalationRouter on startup — agent working it now

## Known Issues

- `ceremony-loader` warns on startup: `daily-standup.yaml` missing required `schedule` field — not a blocker
- `escalations.json` at `/data/escalations.json` may be corrupt — EscalationRouter logs a parse error and skips loading escalation state. Bug ticket filed, fix incoming via auto-mode.
- `plane-hitl` fix (#42) is deployed but needs `projects.yaml` to have Discord channel IDs populated for the Plane HITL flows to route correctly

## World Engine Architecture

The World Engine is a homeostatic infrastructure layer. Data flow:

```
WorldStateCollector
  → GoalEvaluator (emits world.goal.violated)
    → PlannerL0 (deterministic rules — now wired!)
      → ActionDispatcher
        → Agent / Tool
```

**Plugins registered in `src/index.ts`:**
- `OnboardingPlugin` — project onboarding pipeline
- `CeremonyPlugin` — recurring fleet rituals (standups, retros) via `workspace/ceremonies/*.yaml`
- `FlowMonitorPlugin` — monitors LangGraph flow health

**To add new state/goals/actions:** see `docs/world-engine/extension-guide.md`

## Next Steps for the Team

1. **Populate Discord channel IDs** in `workspace/projects.yaml` — needed for plane-hitl routing and ceremony delivery
2. **Watch the escalations.json bug** — auto-mode is on it, PR incoming
3. **Google Workspace OAuth** — still needs manual setup: register `http://localhost:8765` redirect URI, run OAuth flow, store `GOOGLE_WORKSPACE_REFRESH_TOKEN` in Infisical (AI project)
4. **ceremony `schedule` field** — `workspace/ceremonies/daily-standup.yaml` is missing `schedule`, ceremony-loader skips it on startup

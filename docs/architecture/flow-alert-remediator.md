---
title: Flow — Alert / PR remediator
---

_The fleet self-healing path: AgentFleetHealth aggregates outcomes into a snapshot; when thresholds trip, alert skills publish to Discord; pr-remediator handles `pr.remediate.*` topics that propose code mutations. The threshold-evaluation layer is currently external (Goals/Actions YAML) and is a known architectural seam._

---

## What & why

The fleet is a distributed system; agents fail, PRs get stuck, costs spike. Two related paths handle the response:

- **Alerts** — declarative skill executors (20 of them) that turn a `alert.fleet_*` skill dispatch into a Discord message. Fire-and-forget, no LLM.
- **PR remediator** — five `pr.remediate.*` topics (`update_branch`, `merge_ready`, `fix_ci`, `address_feedback`, `pr.backmerge.dispatch`) that consume an action dispatch and mutate the PR via GitHub API.

Both are `FunctionExecutor`-backed (no LLM at the executor itself; LLM lives one layer deeper in `pr-remediator` for `diagnose_pr_stuck`).

---

## ASCII spine

```
   autonomous.outcome.# (from every skill execution)
        │
        ▼
   ┌──────────────────────────┐
   │ AgentFleetHealthPlugin   │  rolling 24h windows
   │   _record()              │  synthetic actor filter (#459)
   │                          │
   │   computes:              │
   │   • successRate          │
   │   • failureRate1h        │
   │   • p50/p95 latency      │
   │   • cost per outcome     │
   │   • orphanedSkillCount   │
   │   • maxFailureRate1h     │
   └──────────────┬───────────┘
                  │ exposed via getFleetHealth() collector
                  ▼  (called by WorldStateEngine every 60s)
   ┌──────────────────────────┐
   │  world-state domain:     │
   │  agent_fleet_health      │
   └──────────────┬───────────┘
                  │
                  ▼   (?) threshold evaluation
                  │       happens externally — see "Threshold gap" below
                  ▼
   ┌──────────────────────────┐  ┌──────────────────────────┐
   │ alert.fleet_agent_stuck  │  │ action.pr_update_branch  │
   │ alert.fleet_skill_       │  │ action.pr_fix_ci         │
   │   orphaned               │  │ action.pr_address_       │
   │ alert.fleet_cost_over_   │  │   feedback               │
   │   budget                 │  │ action.pr_merge_ready    │
   │ … (20 alert skills)      │  │ action.pr_backmerge      │
   └──────────────┬───────────┘  └──────────────┬───────────┘
                  │                              │
                  ▼  SkillDispatcher              ▼  SkillDispatcher
   ┌──────────────────────────┐  ┌──────────────────────────┐
   │ AlertSkillExecutorPlugin │  │ PrRemediatorSkillExec.   │
   │  → message.outbound.     │  │  → pr.remediate.{action} │
   │      discord.alert       │  │                          │
   └──────────────────────────┘  └──────────────┬───────────┘
                                                 │
                                                 ▼
                                  ┌──────────────────────────┐
                                  │ PrRemediatorPlugin       │
                                  │  reads pr_pipeline state │
                                  │  publishes GitHub mut.   │
                                  │  or HITL escalation      │
                                  └──────────────────────────┘
```

---

## Sequence (alert path)

```mermaid
sequenceDiagram
    autonumber
    participant SD as SkillDispatcher
    participant FH as AgentFleetHealth
    participant WSE as WorldStateEngine<br/>(60s tick)
    participant TE as Threshold evaluator<br/>(external)
    participant AD as ActionDispatcher
    participant AE as AlertSkillExecutor
    participant Bus as Bus
    participant DP as DiscordPlugin

    Note over SD,FH: every skill outcome flows in
    SD->>Bus: autonomous.outcome.{actor}.{skill}
    Bus->>FH: deliver
    FH->>FH: _record(): rolling window + synthetic-actor filter

    Note over WSE,FH: every 60s
    WSE->>FH: getFleetHealth()
    FH-->>WSE: FleetHealthSnapshot

    Note over TE: ⚠ threshold evaluation<br/>not in source — see gap section
    TE->>Bus: agent.skill.request<br/>(skill=alert.fleet_agent_stuck)
    Bus->>SD: deliver
    SD->>AE: execute(req)
    AE->>Bus: message.outbound.discord.alert
    Bus->>DP: deliver
    DP->>DP: post to alert webhook channel
```

## Sequence (PR remediator path)

```mermaid
sequenceDiagram
    autonumber
    participant TE as Threshold/policy<br/>(external)
    participant Bus as Bus
    participant SD as SkillDispatcher
    participant PRE as PrRemediatorSkillExec
    participant PR as PrRemediatorPlugin
    participant GH as GitHub API

    TE->>Bus: agent.skill.request<br/>(skill=action.pr_update_branch)
    Bus->>SD: deliver
    SD->>PRE: execute (FunctionExecutor)
    PRE->>Bus: pr.remediate.update_branch
    Bus->>PR: deliver

    PR->>PR: read pr_pipeline world state
    PR->>GH: PATCH /repos/{o}/{r}/pulls/{n}/branch
    GH-->>PR: response

    alt success
        PR->>Bus: flow.item.updated / completed
    else 422 conflict (2+ attempts)
        PR->>PR: dispatch diagnose_pr_stuck (LLM verdict)
        alt decomposable + promotion PR
            Note over PR: #465 destructive guard:<br/>suppress close, escalate HITL
        else genuine conflict
            PR->>PR: escalate HITL (console.warn only)
        end
    end
```

---

## Bus topic table

### Fleet health

| Topic | Published by | Subscribed by | File:line |
|---|---|---|---|
| `autonomous.outcome.#` | SkillDispatcher | AgentFleetHealthPlugin | `src/plugins/agent-fleet-health-plugin.ts:159` |
| `agent_fleet_health` (world-state) | FleetHealth.getFleetHealth() collector | WorldStateEngine | `src/plugins/agent-fleet-health-plugin.ts:180` |

### Alerts (20 skills total — sample)

| Skill (on `agent.skill.request`) | Severity | Outbound topic |
|---|---|---|
| `alert.fleet_agent_stuck` | high | `message.outbound.discord.alert` |
| `alert.fleet_skill_orphaned` | medium | `message.outbound.discord.alert` |
| `alert.fleet_cost_over_budget` | high | `message.outbound.discord.alert` |
| … (full list in `AlertSkillExecutorPlugin.ALERT_SKILLS`, [line 39–67](../../src/plugins/AlertSkillExecutorPlugin.ts)) | | |

All 20 are `FunctionExecutor` registrations with priority=5, fire-and-forget, no LLM.

### PR remediator

| Skill | Topic published | Handler in `pr-remediator.ts` |
|---|---|---|
| `action.pr_update_branch` | `pr.remediate.update_branch` | line 1006+ |
| `action.pr_merge_ready` | `pr.remediate.merge_ready` | line 985+ |
| `action.pr_fix_ci` | `pr.remediate.fix_ci` | line 750+ |
| `action.pr_address_feedback` | `pr.remediate.address_feedback` | line 750+ |
| `action.pr_backmerge` | `pr.backmerge.dispatch` | line 6+ |

PrRemediatorSkillExecutorPlugin maps skill→topic; PrRemediatorPlugin subscribes to all five.

---

## Synthetic actor filter (#459)

Lives at [AgentFleetHealthPlugin._record:281–334](../../src/plugins/agent-fleet-health-plugin.ts). Detail in [chokepoint-invariants](chokepoint-invariants.md).

Summary: `pr-remediator`, `auto-triage-sweep`, `goap`, `user` are recognized synthetic actors. Their outcomes go into `systemActors[]` bucket (not `agents[]`) so they don't inflate `agentCount` or skew `maxFailureRate1h`.

---

## Threshold gap

**Where threshold evaluation actually happens is not fully visible in the audited source.** The audit found:

- `ALERT_SKILLS` declares 20 alert skill names
- `FleetHealthSnapshot` exposes the relevant metrics (`maxFailureRate1h`, `orphanedSkillCount`, `totalCostUsd1d`, …)
- `ActionDispatcherPlugin` presumably dispatches `alert.*` and `action.*` skills when preconditions match — but the **goals/actions YAML files were not found** in the audited tree

This points at a **partial GOAP layer still wired** despite memory saying GOAP is being removed (see [memory: app-is-switchboard](../../.claude/projects/-home-josh-dev-protoWorkstacean/memory/project_app_is_switchboard.md)). One of two states is true:

1. The GOAP layer is fully torn out and threshold evaluation has moved elsewhere (e.g. a simple cron-based threshold-checker) — in which case `AlertSkillExecutorPlugin` no longer fires today
2. The GOAP layer is partially still in place, driving alerts/actions from `agent_fleet_health` world-state

A maintainer needs to resolve this before the doc can claim a complete picture. **Tracking gap; not blocking the rest of the doc.**

---

## PR remediator state machine

PrRemediatorPlugin (`lib/plugins/pr-remediator.ts`) maintains in-memory `inFlight` Map per PR:

```
InFlightEntry {
  attemptCount,
  escalated,
  diagnostics?,
  …
}
```

Key transitions ([pr-remediator.ts:604+](../../lib/plugins/pr-remediator.ts)):
- Fresh PR → enter inFlight, attempt = 0
- Each `pr.remediate.*` consume → attempt += 1, try GitHub mutation
- Attempt count ≥ `MAX_ATTEMPTS_PER_PR` (3) → mark escalated, emit HITL (see gap in [flow-hitl](flow-hitl.md))
- 422 conflict on `update_branch` after 2 attempts → dispatch `diagnose_pr_stuck` for LLM verdict
- Verdict `genuine` → immediate HITL
- Verdict `decomposable` + promotion PR → suppress close, HITL (defense-in-depth #465)

---

## Failure modes & gotchas

- **Live CI re-check before fix_ci escalation** ([line 821–830](../../lib/plugins/pr-remediator.ts)) — before emitting HITL for "stuck on CI", pr-remediator hits GitHub live API to confirm CI is still red. If it flipped green between snapshot and escalation, the escalation is silently dropped. Prevents stale-snapshot false alarms.
- **Alert thresholds are hard-coded in source** — `WINDOW_MS = 24h`, `MAX_RECENT_FAILURES = 10`. No env override. Changing these requires a rebuild.
- **Cost calculation depends on `MODEL_RATES`** ([lib/types/budget.ts](../../lib/types/budget.ts)) — hard-coded model price table. When LiteLLM gateway adds a new model, this table must be updated or `costUsd` is zero for that model.
- **Outcome attribution is write-time, not read-time** ([line 281](../../src/plugins/agent-fleet-health-plugin.ts)) — `systemActor` is bucketed *as outcomes arrive*. If `ExecutorRegistry` enrolls a new agent later, prior outcomes for that name stay in `systemActors[]`. Restart required to re-bucket.
- **`agent.runtime.activity.tool.call` and `agent.skill.latency` topics are referenced in some commentary but NOT in source** ([all-topics.ts](../../src/event-bus/all-topics.ts)) — see [flow-agent-runtime-telemetry](flow-agent-runtime-telemetry.md). If a tile or alert depends on them, it's broken today.

---

## Related

- [chokepoint-invariants](chokepoint-invariants.md) — #459 synthetic actor filter, #465 destructive verdict guard
- [flow-hitl](flow-hitl.md) — the escalation path (with the wire-incomplete gap)
- [flow-agent-runtime-telemetry](flow-agent-runtime-telemetry.md) — what feeds the snapshot
- [flow-dashboard](flow-dashboard.md) — how the snapshot is rendered

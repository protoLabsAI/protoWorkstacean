---
title: Cross-cut — Dispatcher chokepoint invariants
---

_The "dispatcher invariants" pattern referred to elsewhere in the codebase. This doc audits what is actually in source vs. what was planned. Two are true dispatcher invariants; one fleet-side filter lives outside the dispatcher entirely. (A fourth — the #465 destructive-verdict guard — lived in the now-deleted `pr-remediator.ts` and is no longer in the codebase; see the historical note below.)_

---

## What & why

A single chokepoint enforcing invariants is easier to reason about than the same checks scattered across plugins. The `agent.skill.request` topic is that chokepoint — `SkillDispatcherPlugin` is the **sole subscriber**, so anything declared as a "dispatcher invariant" must live in its `_dispatch()` method.

Audit reality:

| # | Invariant | Location in source | Generalized at dispatcher? |
|---|---|---|---|
| #437 | Cooldown | `src/executor/skill-dispatcher-plugin.ts:216-230` | ✅ yes |
| #444 | Target-registry guard | `src/executor/executor-registry.ts:93-97` (inside `resolve()`) | ✅ effectively — dispatcher drops on null resolve |
| #459 | Synthetic actor filter | `src/plugins/agent-fleet-health-plugin.ts:281-334` | ❌ **outside** the dispatcher (fleet-health aggregation site) |
| #465 | Destructive verdict guard | _retired — lived in `pr-remediator.ts`, deleted #776_ | ❌ **no longer in the codebase** |

Treat #437 and #444 as the actual dispatcher invariants. #459 is the same architectural *pattern* (single chokepoint for an invariant) applied at a *different* chokepoint — the outcome-aggregation site. #465 was that pattern applied at the PR-remediator verdict-handling site; it was removed when `pr-remediator.ts` was deleted (the PR-pipeline-violation derivation it guarded moved to protoMaker — see [flow-alert-remediator](flow-alert-remediator.md)).

---

## Dispatcher chokepoint sequence (#437 + #444)

```
   agent.skill.request
          │
          ▼
   ┌──────────────────────────────────────────┐
   │ SkillDispatcherPlugin._dispatch()        │
   │                                          │
   │ 1. mark activeExecutions   (line 189)    │  ← gate against concurrent DM turns
   │ 2. skill present?          (line 191)    │  ← drop if missing
   │ 3. resolve(skill, targets) (line 198)    │  ← #444 lives in resolve()
   │      ├─ null  ─►  drop + error response  │
   │      └─ executor                         │
   │ 4. cooldown check          (line 216)    │  ← #437
   │      ├─ trip  ─►  drop + error response  │
   │      └─ pass                             │
   │ 5. flow.item.created                     │
   │ 6. await executor.execute()  (line 286)  │  ← no timeout wrapper
   │ 7. publish outcome           (line 538)  │
   │ 8. finally: drain mailbox    (line 478)  │
   └──────────────────────────────────────────┘
```

Order matters: registry guard fires **before** cooldown so a misdirected request gets the more useful diagnostic. Both fire before any side-effects (no `flow.item.created`, no executor call).

---

## #437 — Cooldown

**Why it exists:** prevents webhook floods from re-triggering the same `(skill, repo)` faster than the agent can respond. A second `pr_review` arriving 5s after the first is almost always a duplicate, not a real new request.

**State:** in-memory `lastDispatchAt: Map<string, number>` ([skill-dispatcher-plugin.ts:124](../../src/executor/skill-dispatcher-plugin.ts)). Key: `{skill}:{owner}/{repo}` or `{skill}:_` if no repo context.

**Defaults:** `bug_triage` 30s, `pr_review` 30s, `security_triage` 60s, others unset (no cooldown). Env override: `WORKSTACEAN_COOLDOWN_MS_<SKILL>` ([line 54–73](../../src/executor/skill-dispatcher-plugin.ts)).

**On trip:**
- `console.warn` with elapsed/window/remaining (line 223–226)
- Error response published to `reply.topic` (line 227)
- **No bus event** for the trip itself — dashboard can't count cooldown drops

**Greenfield rule:** absence of a default = no cooldown. There is no `enabled: false` flag; the absence is the signal.

---

## #444 — Target-registry guard

**Why it exists:** if `payload.targets: ["protomaker"]` points at an agent that isn't enrolled (typo, undeployed, hostname changed — see #608), failing loudly at dispatch beats a silent timeout downstream.

**Implementation:** inside `ExecutorRegistry.resolve(skill, targets)` ([executor-registry.ts:93–97](../../src/executor/executor-registry.ts)):

```
if targets.length > 0:
    for each registration:
        if registration.agentName ∈ targets:
            return registration.executor
    return null  ← dispatcher drops on this null
else:
    fall through to skill-based routing
```

**State:** `_registrations: Array<ExecutorRegistration>` ([executor-registry.ts:45](../../src/executor/executor-registry.ts)). Populated at startup by `AgentRuntimePlugin` (in-process agents) and `SkillBrokerPlugin` (A2A discovery, async). 

**On trip:**
- Dispatcher logs `[skill-dispatcher] No executor found for targets [...] or skill "..." — dropping` ([line 205](../../src/executor/skill-dispatcher-plugin.ts))
- Error response to `reply.topic`
- **No HITL escalation**

**Note on the `"all"` sentinel:** memory referenced an `"all"` broadcast opt-out. Not present in current source. Either it was removed or was never implemented. If broadcast is needed, the absence of `targets[]` already triggers skill-based routing — which dispatches to the *first* matching executor, not all of them.

---

## #459 — Synthetic actor filter (lives elsewhere)

**Where:** `AgentFleetHealthPlugin._record` ([agent-fleet-health-plugin.ts:281–334](../../src/plugins/agent-fleet-health-plugin.ts)). Subscribes to `autonomous.outcome.#`, not `agent.skill.request`.

**Why it's not at the dispatcher:** the dispatcher *publishes* outcomes; it cannot also gate them or it would refuse to publish telemetry about itself. The filter belongs at the *consumer* — fleet-health is the consumer that cares about whether `systemActor` is an actual agent vs. a plugin label.

**What it does:**

```
on autonomous.outcome.{actor}.{skill}:
    if ExecutorRegistry.list().some(r => r.agentName === actor):
        → agentWindows[actor].push(outcome)
        → contributes to agentCount, maxFailureRate1h, orphanedSkillCount
    else:
        → systemActorWindows[actor].push(outcome)
        → exposed separately in FleetHealthSnapshot.systemActors[]
        → logged once-per-distinct-actor at warn level
```

**Known synthetic actors:** `feature-remediation`, `user`.

**On trip:** one-time `console.warn` per actor, no escalation. The point is bucketing, not blocking.

---

## #465 — Destructive verdict guard (RETIRED — no longer in code)

**Status:** removed. This invariant lived in `lib/plugins/pr-remediator.ts`, which was **deleted in #776**. It is documented here only as history — there is no destructive-verdict guard in the current codebase, because the LLM-driven PR-close verdict it guarded no longer exists in workstacean.

**What it did:** inside the old pr-remediator's `diagnose_pr_stuck` verdict handling, when an LLM verdict on a stuck PR was `decomposable` (i.e. "close this and re-cut as smaller PRs"), the handler checked whether the PR was a promotion PR (`head ∈ {dev, staging}` OR `base ∈ {main, staging}` OR title starts with "Promote"). If so, the close was suppressed and an HITL escalation emitted instead.

**Why it's gone:** workstacean no longer re-derives PR-pipeline violations or issues destructive PR verdicts. protoMaker now detects stuck PRs as blocked features and emits a single canonical `feature.blocked` signal; `FeatureRemediationPlugin` routes that to Roxy's `unblock_feature` skill or to HITL (see [flow-alert-remediator](flow-alert-remediator.md)). Roxy may take unblocking actions, but the promotion-PR destructive-close path that #465 guarded no longer exists on the workstacean side.

If a new LLM-driven destructive verb appears later (e.g. `delete issue`, `force-update ref`), the right pattern is the same one #465 used — guard it next to the verb's consumer, and only promote it to a dispatcher invariant if it generalizes across skills.

---

## Telemetry (resolved by #620 + #622)

The dispatcher publishes `dispatch.dropped.{reason}` at each chokepoint drop site (shipped in **#620**), and the `dispatch-drop-escalator` plugin watches for storms — N drops on the same key in M minutes → operator DM via `operator.message.request` (shipped in **#622**).

| Topic | Published at | Subscribed by |
|---|---|---|
| `dispatch.dropped.no_skill` | `skill-dispatcher-plugin.ts:201-208` | dashboard, dispatch-drop-escalator |
| `dispatch.dropped.target_unresolved` | `:212-223` | dashboard, dispatch-drop-escalator |
| `dispatch.dropped.cooldown` | `:236-249` | dashboard, dispatch-drop-escalator |

Payload shape: `DispatchDroppedPayload` in `src/event-bus/payloads.ts` — uniform across reasons, with reason-specific optional fields (`cooldownKey`, `cooldownWindowMs`, `cooldownRemainingMs`). The console.warn at each site is kept for log-tail visibility — bus and stdout fire independently.

The synthetic-actor filter (#459) still doesn't publish a "filtered" event — by design, since synthetic actors are *expected* and the bucketing is the signal. If we ever need to detect a *new* synthetic actor appearing, that's worth surfacing — open follow-up.

---

## When to add a new invariant

If you find yourself adding a check that:

- Must fire before any executor work happens, **and**
- Applies to *all* `(skill, target)` pairs (not just one skill / one plugin)

…then add it to `_dispatch()` in the same sequence (after registry resolve, before cooldown is fine — the order between these is semantic, see [#437 above](#437--cooldown)).

If the check is **specific to one skill or one verb** (as #465's now-retired PR-close guard was), put it next to the consumer, not at the dispatcher. The dispatcher is for invariants every skill must respect.

---

## Related

- [flow-inbound-message](flow-inbound-message.md) — full dispatcher sequence with these invariants in context
- [flow-alert-remediator](flow-alert-remediator.md) — #459's downstream consumer; also where the retired #465 guard's responsibility moved (protoMaker + feature-remediation)
- [flow-hitl](flow-hitl.md) — the operator-escalation path

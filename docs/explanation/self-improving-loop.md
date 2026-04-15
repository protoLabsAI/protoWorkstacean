---
title: The self-improving loop
---

protoWorkstacean's GOAP loop doesn't just react to world state — it learns from every dispatch and uses that history to make future decisions. This page explains how observations flow from A2A extensions into the planner's candidate ranking, where the learning is lossy on purpose, and what's still ahead.

---

## The pipeline

```
world state change
   │
   ▼
┌─────────────────────┐
│ WorldStateEngine    │  polls HTTP domains, publishes world.state.updated
└─────────────────────┘
   │
   ▼
┌─────────────────────┐
│ GoalEvaluatorPlugin │  evaluates workspace/goals.yaml → world.goal.violated
└─────────────────────┘
   │
   ▼
┌─────────────────────┐
│ PlannerPluginL0     │  selects candidate skills via ExecutorRegistry.resolveByEffect
│   ├─ ranks by:      │  Arc 6.4 ranking (this page's focus)
│   │   - observed    │
│   │     success     │  ←──── cost-v1 extension populates CostStore
│   │   - observed    │
│   │     confidence  │  ←──── confidence-v1 extension populates ConfidenceStore
│   │   - wall-time   │
│   └─ cold fallback: │
│     card confidence │
└─────────────────────┘
   │
   ▼
┌─────────────────────┐
│ ActionDispatcher    │  publishes agent.skill.request with systemActor="goap"
└─────────────────────┘
   │
   ▼
┌─────────────────────┐
│ SkillDispatcher     │  resolves executor → A2AExecutor.execute
│                     │  writes system_goap episodic memory to Graphiti
└─────────────────────┘
   │
   ▼
┌─────────────────────┐
│ A2AExecutor         │  runs extension before/after interceptors around the RPC
│   before hooks:     │    - cost-v1 stamps x-cost-skill metadata
│                     │    - confidence-v1 stamps x-confidence-skill
│                     │    - effect-domain-v1 stamps x-effect-domain-skill
│                     │    - blast-v1 stamps x-blast-radius (from card)
│                     │    - hitl-mode-v1 stamps x-hitl-mode (from card)
│   after hooks:      │    - cost-v1 records tokens + wall-time → CostStore
│                     │    - confidence-v1 records self-assessment → ConfidenceStore
│                     │    - effect-domain-v1 publishes world.state.delta
└─────────────────────┘
   │
   ▼
┌─────────────────────┐
│ autonomous.outcome  │  ActionDispatcher publishes terminal outcome on
│   .goap.{skill}     │  autonomous.outcome.goap.{skill}
└─────────────────────┘
   │
   ├──▶ PlannerPluginL0: records in LoopDetector, sets success cooldown
   ├──▶ OutcomeAnalysisPlugin: aggregates per-skill stats, alerts on chronic failure
   └──▶ Dashboard / external subscribers: fleet cost view
```

The next `world.goal.violated` for the same goal will land on a planner that's updated both its loop-detection history AND the candidate stores — so the ranking reflects what just happened.

---

## Arc 6.4 — how observations beat priors

Before Arc 6.4, `PlannerPluginL0.resolveByEffect` ranked candidates purely by `reg.confidence` — the confidence each agent declares about itself in its `effect-domain-v1` card block. That's fine as a cold-start prior, but ignores every signal we've actually collected.

The ranking module (`src/planner/candidate-ranking.ts`) replaces that sort with:

```ts
warm (>= 5 samples):
  score = 2.0 * cost.successRate
        + 0.5 * confidence.avgConfidenceOnSuccess
        - 0.3 * clamp(cost.avgWallMs / 60_000, 0, 2)

cold:
  score = reg.confidence   // card's own prior
```

The design intent is **observed data dominates priors once warm**. A card advertising 0.9 confidence with no supporting observations won't outrank a skill with 10 runs at 50% success — real samples win. This is deliberate: it means new agents that over-promise in their card are quickly corrected by the world, and agents that correctly hedge keep their ranking.

### Cold-start handling

The `MIN_SAMPLES_FOR_TRUST` constant (default: 5) draws the cold/warm boundary. Below 5 samples, an agent's self-declared confidence is all we have, so we use it directly. Once warm, observations take over completely — there's no blended regime because it makes the ranking harder to reason about for little gain. Testing regressions this way is also straightforward: a single `sampleCount` threshold.

### Stable tiebreak

When two candidates score identically (common in the cold regime with matching card confidences) the sort tiebreaks on `reg.confidence` descending. Identical inputs produce identical ordering — deterministic enough to test.

---

## What each extension contributes

| Extension | Reads from | Writes to | Consumer |
|---|---|---|---|
| [`cost-v1`](../extensions/cost-v1.md) | `result.data.usage`, `durationMs`, `costUsd`, `success` | `defaultCostStore` + `autonomous.cost.*` topic | Planner ranking, dashboard, `OutcomeAnalysis` action-quality alerts |
| [`confidence-v1`](../extensions/confidence-v1.md) | `result.data.confidence`, `confidenceExplanation`, `success` | `defaultConfidenceStore` + `autonomous.confidence.*` topic | Planner ranking, calibration dashboard |
| [`effect-domain-v1`](../extensions/effect-domain-v1.md) | `worldstate-delta-v1` artifact DataPart | `world.state.delta` bus event | `WorldStateEngine` applies deltas, planner sees fresh state faster |
| [`blast-v1`](../extensions/blast-v1.md) | `capabilities.extensions[].params.skills` on the agent card | `defaultBlastRegistry` + stamps `x-blast-radius` on outbound metadata | HITL policy + planner tiebreaker + dashboard severity coloring |
| [`hitl-mode-v1`](../extensions/hitl-mode-v1.md) | `capabilities.extensions[].params.skills` on the agent card | `defaultHitlModeRegistry` + stamps `x-hitl-mode` on outbound metadata | `HITLPlugin` flow selection (autonomous / notification / veto / gated / compound); sub-agent `input-required` routes back to dispatching agent, human fallback |

All five interceptors are registered once at startup (`src/index.ts`) and fire on every A2A dispatch regardless of whether the agent's card opts in — they self-gate by checking for their expected response fields or card declarations. Agents that don't opt in produce no samples and no metadata stamps; agents that do get their samples counted. No config change needed on either side when a new agent joins the fleet.

---

## Episodic memory — the parallel track

Observations aren't the only thing captured on each dispatch. `SkillDispatcherPlugin` also writes a Graphiti episode for every successful skill completion:

- **Human-originated** dispatches write to two groups: `user_{platform}_{userId}` (shared across agents — the user's common memory) and `agent_{agentName}__{user_...}` (this specific agent's relationship with this user). This applies to all channels — Discord, GitHub, Plane, Slack, Signal — wherever `msg.source.userId` and `msg.source.platform` are present.
- **Bot-originated** dispatches (`meta.systemActor` set, e.g. `"goap"`) write to a single `system_{actor}` group — the autonomous loop's own episodic log of what it did.

On the next turn, before the skill fires, the dispatcher reads back a `<recalled_memory>` block from Graphiti and injects it into the prompt. Ava and protoBot's system prompts explicitly tell them what the block is ("trusted background — prior commitments, workflow preferences, past provisioning decisions") so they use it silently.

The loop's episodic track gives the autonomous system its own long memory: it knows what it has tried, what worked, who the user is. Combined with the ranking track, future dispatches are informed both by aggregate statistics (the stores) and specific context (the graph).

---

## Why the loops don't diverge

An earlier attempt to close `outcome → state` by republishing `world.state.updated` after each outcome caused infinite re-dispatch: the optimistic effects hadn't caught up to real domain state, so the goal was still violated, and the planner fired again. We disabled that re-publish (see `action-dispatcher-plugin.ts:330`) and now rely on two guards:

1. **In-flight tracking** — `PlannerPluginL0.inFlightGoals` prevents a second dispatch for the same goal while one is running.
2. **Post-success cooldown** — after a successful outcome with real effects, the planner sets a 90-second cooldown so the next real domain poll has time to confirm the change before the goal is re-evaluated.

`world.state.delta` (from `effect-domain-v1`) is a more precise path forward: agents declare the exact mutation they made, `WorldStateEngine` applies it in-process, and the planner sees fresh state without waiting for the next poll or risking optimistic-effect drift. That path exists today but isn't the primary convergence mechanism yet.

---

## Fleet-level rollups — `agent_fleet_health`

`AgentFleetHealthPlugin` (Arc 8.1) subscribes to `autonomous.outcome.#` and keeps a rolling 24-hour window of every autonomous dispatch. For each agent (`AgentFleetMetrics`) it exposes:

- `successRate` — fraction of the window's outcomes that succeeded
- `p50LatencyMs` / `p95LatencyMs` — wall-clock distribution
- `costPerSuccessfulOutcome` — total window cost ÷ success count (from `cost-v1` usage samples when available, falling back to `MODEL_RATES["default"]` token pricing); 0 when no successes
- `totalCostUsd` — raw LLM spend for all outcomes in the window
- `failureRate1h` — failure fraction over the last 1h (a sub-window of the 24h window)
- `recentFailures` — last 10 failure correlation IDs + reasons for drill-down
- `totalOutcomes` — total outcome events in the window

The `FleetHealthSnapshot` also exposes fleet-level aggregates:

- `maxFailureRate1h` — max `failureRate1h` across all agents; used by `fleet.no_agent_stuck` (Arc 8.2) to fire when any agent's 1h failure rate exceeds 50%
- `totalCostUsd1d` — sum of all agent costs in the window; used by `fleet.cost_under_budget` (Arc 8.3) to fire when fleet LLM spend exceeds $50/day
- `orphanedSkillCount` — skills seen in any outcome in the 24h window that have had zero successful executions; > 0 signals capability regression; used by `fleet.no_skill_orphaned` (Arc 8.5)

Exposed as the `agent_fleet_health` world-state domain via a 60-second collector. Goals target `domains.agent_fleet_health.data.*` selectors — no custom domain code required.

### Health-weighted executor selection (Arc 8.4)

When multiple agents can serve the same skill, `ExecutorRegistry` uses fleet health data to pick probabilistically rather than greedily:

```
weight = successRate × (1 / (1 + costPerSuccessfulOutcome))
```

Agents with no data (`totalOutcomes === 0`) get weight 1.0 so new agents still receive traffic. `AgentFleetHealthPlugin.getFleetHealth()` is the data source; `ExecutorRegistry.setHealthGetter()` wires it at startup.

---

## Closing the other side — goal proposals from chronic failures

`OutcomeAnalysisPlugin` has always emitted `ops.alert.action_quality` on chronic failure clusters. Arc 9.2 added a second output: an `agent.skill.request { skill: "goal_proposal" }` targeting Ava. Ava reads the cluster context (skill, actual vs expected success rate, recent failures) and either proposes a new goal — which `GoalHotReloadPlugin` applies without a restart — or files a feature on the board describing what's missing.

"Bottlenecks are growth" operationalized: the system's own failures become inputs to its own goal backlog, closing the loop from observation → ranking → planner selection → outcome → **goal refinement**.

---

## What's still ahead

- **Ranking tiebreakers beyond Arc 6.4** — blast radius (cost-v1's `highConfFailures` companion in `confidence-v1`), per-user context (Graphiti memory as a ranking signal), recency decay on old samples
- **Durable cost/confidence stores** — current stores are in-memory with 200-sample rolling windows; a SQLite-backed store would let rankings survive restarts and feed historical dashboards
- **Learned policy replacing the hand-tuned weights** — the 2.0 / 0.5 / 0.3 coefficients are intuitive but not optimal. Once the observation stream is persistent, a bandit or Q-learner can pick weights that minimize regret on the goal-violated → dispatched pair
- **Memory-health remediation actions** — `memory.graphiti_healthy` + `memory.search_working` goals evaluate correctly but have no registered action. Graphiti going dark today causes silent degradation rather than an alert + restart

---

## Seeing it in action

```bash
# Watch observation events
docker logs workstacean -f 2>&1 | grep -E "autonomous\.(cost|confidence|outcome)"

# Fleet cost summary via the bus
curl -s http://localhost:8081/api/world-state | jq '.domains.flow.data.costs'

# Current planner ranking for a goal (no dedicated endpoint yet —
# inspect LoopDetector / cooldown state via planner introspection in tests)
bun test src/planner/__tests__/candidate-ranking.test.ts

# Verify extension interceptors fire by chatting with an A2A agent
curl -s -X POST http://localhost:8081/api/a2a/chat \
  -H "Content-Type: application/json" \
  -d '{"agent":"quinn","skill":"pr_review","message":"Review the open queue briefly"}' \
| jq .data
```

After the call, the cost + confidence topics will have fired. A few more calls populate the store; the 6th dispatch and beyond will use observation-weighted ranking for quinn's `pr_review` skill.

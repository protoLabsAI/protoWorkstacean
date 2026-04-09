---
title: World Engine — Concepts
---

# World Engine — Concepts

_This is an explanation doc. It covers the design decisions and mental models behind the World Engine — not the exact API surface._

See also: [`reference/world-engine.md`](../reference/world-engine.md) for schemas, formats, and bus topics.

---

## What is homeostatic infrastructure?

Traditional monitoring is reactive: an alert fires, a human pages someone, they fix it. The World Engine takes a different approach — **homeostatic infrastructure**.

A homeostatic system has a set of declared goals that describe a desired state. It continuously measures actual state, compares it to the goals, and when it detects a deviation it autonomously acts to close the gap — without a human in the loop for routine corrections.

The name comes from biology. A thermostat is homeostatic: it doesn't wait to be told the room is cold. It measures temperature, compares it to a setpoint, and turns on the heater. The World Engine applies the same principle to software infrastructure: service health, board velocity, CI pass rates, portfolio balance.

This is distinct from:

- **Alerting**: Alerting tells a human there is a problem. The World Engine tells the system to fix it.
- **Runbooks**: Runbooks describe manual procedures. The World Engine executes automated plans.
- **Static automation**: Cron jobs run whether needed or not. The World Engine only acts when a goal deviation is detected.

The key invariant is: **goals are declared, not coded**. What "healthy" means lives in `goals.yaml`, not in business logic. This means goal definitions can evolve without touching the planner.

---

## HTN/GOAP hybrid: how action planning works

The World Engine combines two planning paradigms:

**Goal-Oriented Action Planning (GOAP)** defines what the system is trying to achieve. A goal is a predicate on world state — a function that returns `true` when the system is in the desired condition. The planner's job is to find a sequence of actions that transforms current state into a state where the goal predicate returns `true`.

**Hierarchical Task Networks (HTN)** decompose abstract intentions into concrete actions. A portfolio-level objective ("improve system stability") decomposes into project-level tasks ("fix auth service") which decompose into domain-level operations ("restart auth", "roll back config") which finally reach primitive actions ("call restart API endpoint").

The hierarchy has four levels:

```
portfolio  — org-wide strategic objectives
  └── project  — per-project tactical goals
        └── domain  — domain-specific operations (services, CI, board)
              └── action  — primitive executable steps
```

The two paradigms complement each other. GOAP answers "what goal are we trying to satisfy?". HTN answers "what sequence of concrete steps gets us there?". The planner uses HTN decomposition to generate the candidate action set, then A* search to find the least-cost path through that action graph to the goal state.

In practice this means:

1. A goal violation is detected (`world.goal.violated` event)
2. The HTN decomposer traverses the hierarchy top-down, producing a list of applicable primitive actions
3. The A* planner searches through possible action sequences to find the least-cost plan that satisfies the goal
4. The plan is executed (or escalated if outside budget)

---

## Why 4 escalation tiers?

The four-tier ladder (L0 → L1 → L2 → Human) reflects a fundamental trade-off: **cost vs. capability**.

```
Cost (and capability)
▲
│   Human         expensive, most capable, unlimited judgment
│   Ava (L2)      moderate cost, flexible LLM reasoning
│   A* planner    cheap, systematic but bounded
│   Rule matcher  free, instant, but rigid
└────────────────────────────────────► Situations handled
```

**L0 (deterministic rules)** costs nothing. A rule like "if auth is down, restart it" runs in microseconds with no LLM call. It works perfectly for situations that have been seen before and have a known fix. The limitation is brittleness — rules only fire when conditions exactly match.

**L1 (A* planner)** costs very little. A planning call to a cheap model is orders of magnitude less expensive than a full Ava session. The planner can handle novel combinations of actions and goals — it doesn't need a pre-written rule for every situation. It is still bounded: it only knows actions in its action graph, and it runs within a time budget.

**L2 (Ava, LLM reasoning)** handles situations the planner cannot. Ava can reason about ambiguous goals, weigh trade-offs not captured in action costs, ask clarifying questions, and compose actions in ways not represented in the graph. This flexibility comes at a cost — an Ava session is measurably more expensive than a planning call.

**L3 (human)** is the failsafe for situations that exceed the system's authority or capability. Some decisions should not be automated: large expenditures, irreversible actions, policy violations, genuinely novel incidents. The 30-minute HITL approval window gives humans the decision without making them a bottleneck for routine work.

The tier assignment is automatic, driven by two inputs:
- **Estimated cost** of the request
- **Remaining budget ratio** (project and daily)

This ensures the system degrades gracefully as budgets deplete: a request that would be L0 early in the day escalates to L1 or L2 as the budget is consumed.

The target is **85–90% autonomous rate** — meaning ≤ 10–15% of requests reach L2 or higher. If the autonomous rate falls below this, `BudgetPlugin` fires an `ops.alert.budget` event.

---

## A* planner: how budget-bounded action selection works

The L1 planner uses the A* search algorithm to find a least-cost plan through an action graph.

**How A* works here:**

Each node in the search graph represents a possible world state. Each edge represents an action — with a precondition (when can this action be taken?) and an effect (what state change does it produce?). The planner starts at the current world state and searches for a path to a state that satisfies the goal predicate.

A* uses two scores per node:
- `g(n)` — actual cost to reach node `n` from the start (sum of action costs along the path)
- `h(n)` — heuristic estimate of remaining cost to reach the goal from `n`
- `f(n) = g(n) + h(n)` — total estimated cost

The search always expands the node with the lowest `f` score. This guarantees it finds the optimal (least-cost) plan when the heuristic is admissible (never overestimates the true remaining cost).

**Budget bounding:**

The planner runs within explicit limits:

```typescript
interface SearchConfig {
  maxExpansions?: number;   // max nodes to expand before stopping
  timeBudgetMs?: number;    // wall-clock time budget
  weight?: number;          // weight > 1 trades optimality for speed (weighted A*)
}
```

Default budget: 10,000 node expansions, 5,000 ms. If the budget is exhausted before finding a complete plan, the planner returns the best partial plan it found — the path with the lowest `f` score at the frontier. This is the "anytime" property: even a partial plan is useful for escalation context.

**Weighted A*:**

When `weight > 1.0`, `f(n) = g(n) + weight × h(n)`. This inflates the heuristic, making the search greedier. It finds plans faster but may not find the optimal one. This is useful when time budget is tight and "good enough" is acceptable.

**HTN integration:**

The planner doesn't work directly from the raw action graph. The HTN decomposer first traverses the task hierarchy to produce the candidate primitive action set for the current goal. This scopes the search to actions that are relevant to the current objective — reducing the effective branching factor and making search tractable.

---

## Ava as L2: when and why LLM reasoning replaces A*

Ava (the primary agent) serves as the L2 tier — the fallback when A* planning fails or is out of budget.

**When A* fails:**

- The goal cannot be satisfied by any sequence of known actions (the action graph lacks a path)
- The search budget is exhausted before finding a plan
- The estimated cost exceeds the L1 threshold ($1.00)

**What Ava brings:**

A* is a systematic but closed-world planner. It can only use actions explicitly defined in the action graph. It cannot:

- Reason about goals expressed in natural language
- Consult documentation or past incidents
- Propose new action types not in the graph
- Weigh ambiguous trade-offs

Ava operates on the full context of the incident: the violation event, the world state snapshot, recent board state, prior similar incidents from Qdrant. Ava can call tools not in the L1 action graph, ask clarifying questions, and return a prose explanation alongside an action recommendation.

**Why not always use Ava?**

Cost and latency. A full Ava session runs at claude-sonnet or claude-opus token rates. For a routine "auth service is degraded, restart it" correction, that is 10–100× more expensive than a L0 rule execution. The tiered architecture ensures Ava is reserved for situations where its reasoning capability is genuinely needed — not wasted on deterministic tasks.

**The boundary:**

The L0L1Bridge is the handoff point. L0 tries its rule matcher first. If it fails, the bridge constructs an `L0Context` (current state, goal, reason for failure) and passes it to the L1 planner. If L1 also fails (no plan found, budget exceeded), the calling code escalates to L2 (Ava) via the standard A2A routing path.

```
L0 fails → L0Context constructed → L1Planner.planFromContext()
                                          │
                                    Plan found? ──Yes──► Execute
                                          │ No
                                    Escalate to L2 (Ava)
```

This means Ava always receives the L0 failure reason and the partial plan (if any) as context — it starts from the planner's best attempt, not from scratch.

# How to Extend the World Engine

This guide covers the practical steps for adding new monitoring domains, goals, corrective actions, state extensions, custom evaluators, and ceremonies to the World Engine. Each section is self-contained — jump to the one you need.

See also: [`reference/world-engine.md`](../reference/world-engine.md) for schemas and bus topics, [`explanation/world-engine-concepts.md`](../explanation/world-engine-concepts.md) for design rationale.

---

## 1. Add a new world state domain

**When to use this:** You want to collect data from a new source (e.g. Proxmox node health, an external API) and make it available to goals and evaluators.

### Step 1 — Define the domain type in `lib/types/world-state.ts`

Add an interface for your data shape and add an optional field to `WorldState.domains`:

```typescript
// lib/types/world-state.ts

export interface InfraNode {
  name: string;
  cpu: number;   // 0.0–1.0
  mem: number;   // 0.0–1.0
  status: "ok" | "degraded";
}

export interface InfraState {
  nodes: InfraNode[];
  lastCheckedAt: number;  // Unix ms
}

// Add to the domains object in WorldState:
export interface WorldState {
  timestamp: number;
  domains: {
    services?: WorldStateDomain<ServiceState>;
    board?: WorldStateDomain<BoardState>;
    ci?: WorldStateDomain<CIState>;
    portfolio?: WorldStateDomain<PortfolioState>;
    infra?: WorldStateDomain<InfraState>;   // ← add your domain here
  };
  extensions: WorldStateExtensions;
  snapshotVersion: number;
}
```

### Step 2 — Add a tick in `WorldStateCollectorPlugin`

In `lib/plugins/world-state-collector.ts`, add your domain's tick rate and start a ticker:

```typescript
// Add to TICK_RATES:
const TICK_RATES = {
  services: 30_000,
  board: 60_000,
  ci: 300_000,
  portfolio: 900_000,
  infra: 60_000,     // ← 60s tick
} as const;

// In install():
this._startDomainTicker("infra", TICK_RATES.infra);
void this._collectDomain("infra");

// In _collectDomain() switch statement:
case "infra":
  domainData = await this._collectInfra(tickNum);
  break;
```

### Step 3 — Implement the collector function

Add a private method that fetches and normalizes your data:

```typescript
private async _collectInfra(tickNum: number): Promise<WorldStateDomain<InfraState>> {
  const response = await fetch("http://proxmox.internal:8006/api2/json/nodes", {
    headers: { Authorization: `PVEAPIToken=${process.env.PROXMOX_TOKEN}` },
  });
  const json = await response.json() as { data: Array<{ node: string; cpu: number; mem: number; status: string }> };

  const nodes: InfraNode[] = json.data.map(n => ({
    name: n.node,
    cpu: n.cpu,
    mem: n.mem,
    status: n.status === "online" ? "ok" : "degraded",
  }));

  const data: InfraState = {
    nodes,
    lastCheckedAt: Date.now(),
  };

  return {
    data,
    metadata: { collectedAt: Date.now(), domain: "infra", tickNumber: tickNum },
  };
}
```

### Verify it works

After restarting, check the logs for:

```
[world-state-collector] Plugin installed — tickers: services=30s, board=60s, CI=300s, portfolio=900s, infra=60s
```

Query the state on the bus:

```typescript
bus.publish("tool.world_state.get", {
  id: crypto.randomUUID(),
  correlationId: crypto.randomUUID(),
  topic: "tool.world_state.get",
  timestamp: Date.now(),
  payload: { domain: "infra" },
  reply: { topic: "my.reply.topic" },
});
```

---

## 2. Define a goal

**When to use this:** You want the World Engine to detect a specific condition in world state and emit a `world.goal.violated` event when it is breached.

Goals live in `workspace/goals.yaml`. Per-project overrides go in `.automaker/projects/{slug}/goals.yaml`.

### Invariant goal — check a value equals an expected state

```yaml
# workspace/goals.yaml
goals:
  - id: infra.all-nodes-ok          # unique identifier
    type: Invariant
    description: All Proxmox nodes must be operational
    severity: high                  # low | medium | high | critical
    enabled: true                   # default: true
    tags: [infrastructure]
    selector: "domains.infra.data.nodes"   # dot-notation path into WorldState
    operator: truthy                # truthy | falsy | eq | neq | in | not_in
    # expected: omit when using truthy/falsy
```

### Threshold goal — enforce a numeric bound

```yaml
  - id: infra.cpu-headroom
    type: Threshold
    description: Average node CPU must stay below 80%
    severity: medium
    selector: "domains.infra.data.nodes.0.cpu"   # resolves to a number
    max: 0.80                                     # upper bound (inclusive)
    # min: 0.10                                   # optional lower bound
```

### Distribution goal — check proportions across a collection

```yaml
  - id: flow.distribution-balanced
    type: Distribution
    description: Board must have >= 40% features, <= 30% defects
    severity: medium
    selector: "domains.board.data.issues"
    distribution:
      feature: 0.40   # minimum ratio required for this category
      defect: 0.30    # maximum ratio allowed (evaluated as upper bound)
    tolerance: 0.10   # allowed deviation from distribution (default: 0.10)
```

### Per-project override

Create a file with the same `id` at `.automaker/projects/{slug}/goals.yaml` — the project-level definition overrides the global one:

```yaml
# .automaker/projects/alpha/goals.yaml
goals:
  - id: infra.cpu-headroom
    type: Threshold
    description: Alpha project needs tighter CPU headroom
    severity: high
    selector: "domains.infra.data.nodes.0.cpu"
    max: 0.60
```

### How to test a goal manually

Publish a synthetic `world.state.updated` event with a state that should trigger the violation:

```typescript
bus.publish("world.state.updated", {
  id: crypto.randomUUID(),
  correlationId: crypto.randomUUID(),
  topic: "world.state.updated",
  timestamp: Date.now(),
  payload: {
    state: {
      timestamp: Date.now(),
      domains: {
        infra: {
          data: { nodes: [], lastCheckedAt: Date.now() },  // empty nodes → truthy fails
          metadata: { collectedAt: Date.now(), domain: "infra", tickNumber: 1 },
        },
      },
      extensions: {},
      snapshotVersion: 1,
    },
  },
});
```

Watch for `world.goal.violated` events or check the logs for:

```
[goal-evaluator] VIOLATION [HIGH] goal="infra.all-nodes-ok" — Expected "domains.infra.data.nodes" to be truthy, got []
```

### Verify it works

```bash
# Check goals loaded on startup:
grep "\[goal-evaluator\] Loaded" logs/agent.log
# → [goal-evaluator] Loaded 4 goal(s) from global
```

---

## 3. Register a corrective action

**When to use this:** You want the World Engine to take an automatic action (send an alert, trigger a ceremony, invoke an agent) when a specific goal is violated.

Actions live in `workspace/actions.yaml`.

### Complete worked example: goal breach → alert → Discord

```yaml
# workspace/actions.yaml
actions:
  - id: alert.infra-nodes-down       # unique identifier
    goalId: infra.all-nodes-ok       # must match a goal id in goals.yaml
    tier: tier_0                     # tier_0 = deterministic/free; tier_1 = A* planned; tier_2 = LLM
    priority: 10                     # higher priority actions are tried first
    cost: 1                          # relative cost unit for the planner

    name: "Alert when Proxmox nodes are unreachable"

    preconditions:                   # all must match for the action to fire
      - path: "domains.infra.data.nodes"   # dot-notation into WorldState
        operator: falsy                    # eq | neq | lt | gt | lte | gte | truthy | falsy

    effects:                         # what the action claims to change (used by planner)
      - path: "domains.infra.data.nodes"
        operation: set               # set | increment | decrement | delete
        value: []                    # value to set (only for set operations)

    meta:
      topic: "message.outbound.discord.alert"   # bus topic the dispatcher publishes to
      agentId: ava                              # optional: agent that handles this topic
```

### Tier reference

| Tier | Label | Use |
|------|-------|-----|
| `tier_0` | Deterministic | Free, no model call — rule match → publish to topic |
| `tier_1` | A*-planned | Cheap model call — planner finds optimal action sequence |
| `tier_2` | LLM | Ava evaluates situation and selects action |

### Precondition operators

`eq`, `neq`, `lt`, `gt`, `lte`, `gte`, `truthy`, `falsy`

### Effect operations

| Operation | Effect |
|-----------|--------|
| `set` | Sets `path` to `value` |
| `increment` | Adds `value` to current number at `path` |
| `decrement` | Subtracts `value` from current number at `path` |
| `delete` | Removes `path` from state |

### Verify it works

After a `world.goal.violated` event fires for your goal, watch the logs for:

```
[action-dispatcher] Dispatching action "alert.infra-nodes-down" → topic "message.outbound.discord.alert"
```

---

## 4. Add a state extension

**When to use this:** You want to maintain stateful data in `WorldState.extensions` that is derived from bus events rather than polled on a tick. Use this for event-driven state: ceremony history, feature flag snapshots, or external webhook data.

Reference implementation: [`src/world/extensions/CeremonyStateExtension.ts`](../../src/world/extensions/CeremonyStateExtension.ts)

### Step 1 — Create `src/world/extensions/{name}StateExtension.ts`

```typescript
// src/world/extensions/InfraAlertStateExtension.ts

import type { EventBus, BusMessage } from "../../../lib/types.ts";

export interface InfraAlertState {
  activeAlerts: string[];   // node names currently alerting
  lastUpdatedAt: number;
}

export class InfraAlertStateExtension {
  private bus: EventBus | null = null;
  private subscriptionIds: string[] = [];

  private state: InfraAlertState = {
    activeAlerts: [],
    lastUpdatedAt: Date.now(),
  };

  /** Install onto the EventBus to receive relevant events. */
  install(bus: EventBus): void {
    this.bus = bus;

    const subId = bus.subscribe("infra.#", "infra-alert-extension", (msg: BusMessage) => {
      this._handleInfraEvent(msg);
    });
    this.subscriptionIds.push(subId);
  }

  /** Uninstall from the EventBus. */
  uninstall(): void {
    if (this.bus) {
      for (const id of this.subscriptionIds) {
        this.bus.unsubscribe(id);
      }
    }
    this.subscriptionIds = [];
    this.bus = null;
  }

  /** Get a snapshot of current state. */
  getState(): InfraAlertState {
    return { ...this.state };
  }

  private _handleInfraEvent(msg: BusMessage): void {
    const payload = msg.payload as { nodeName?: string; resolved?: boolean };

    if (payload.resolved && payload.nodeName) {
      this.state.activeAlerts = this.state.activeAlerts.filter(n => n !== payload.nodeName);
    } else if (payload.nodeName && !this.state.activeAlerts.includes(payload.nodeName)) {
      this.state.activeAlerts.push(payload.nodeName);
    }

    this.state.lastUpdatedAt = Date.now();
    this._publishSnapshot();
  }

  private _publishSnapshot(): void {
    if (!this.bus) return;

    const topic = "world.state.snapshot";
    this.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic,
      timestamp: Date.now(),
      payload: {
        domain: "extensions.infraAlerts",
        data: this.getState(),
      },
    });
  }
}
```

### Step 2 — Register in `WorldStateCollectorPlugin`

In `lib/plugins/world-state-collector.ts`, import and wire up the extension:

```typescript
import { InfraAlertStateExtension } from "../../src/world/extensions/InfraAlertStateExtension.ts";

// Add as a class field:
private infraAlerts = new InfraAlertStateExtension();

// In install():
this.infraAlerts.install(bus);

// In uninstall():
this.infraAlerts.uninstall();
```

The extension's state is then accessible via `WorldState.extensions.infraAlerts` to any downstream evaluator or goal selector.

### Verify it works

Publish a test event and watch for `world.state.snapshot` on the bus:

```typescript
bus.subscribe("world.state.snapshot", "test", (msg) => {
  const { domain, data } = msg.payload as { domain: string; data: unknown };
  if (domain === "extensions.infraAlerts") {
    console.log("Infra alert state updated:", data);
  }
});
```

---

## 5. Write a custom evaluator

**When to use this:** The built-in Invariant, Threshold, and Distribution types cannot express your condition (e.g. temporal patterns, cross-domain joins, ratio comparisons between two selectors).

### Step 1 — Create `src/evaluators/{name}_evaluator.ts`

```typescript
// src/evaluators/cross_domain_evaluator.ts

import type { Goal, GoalViolation } from "../types/goals.ts";
import type { WorldState } from "../types/state_diff.ts";
import { resolvePath } from "../engines/state_diff_engine.ts";

export interface CrossDomainGoal extends Goal {
  type: "CrossDomain";
  selectorA: string;   // dot-notation path for first value
  selectorB: string;   // dot-notation path for second value
  operator: "ratio_gt" | "ratio_lt";
  threshold: number;
}

export class CrossDomainEvaluator {
  evaluate(goal: CrossDomainGoal, state: WorldState, projectSlug?: string): GoalViolation | null {
    if (goal.enabled === false) return null;

    const { found: foundA, value: valueA } = resolvePath(state, goal.selectorA);
    const { found: foundB, value: valueB } = resolvePath(state, goal.selectorB);

    if (!foundA || !foundB) return null;

    const a = typeof valueA === "number" ? valueA : 0;
    const b = typeof valueB === "number" ? valueB : 0;
    const ratio = b === 0 ? 0 : a / b;

    const violated =
      goal.operator === "ratio_gt" ? ratio <= goal.threshold :
      goal.operator === "ratio_lt" ? ratio >= goal.threshold :
      false;

    if (!violated) return null;

    return {
      goalId: goal.id,
      goalType: goal.type,
      severity: goal.severity ?? "medium",
      description: goal.description,
      message: `Ratio of "${goal.selectorA}" / "${goal.selectorB}" = ${ratio.toFixed(2)}, expected ${goal.operator} ${goal.threshold}`,
      actual: ratio,
      expected: goal.threshold,
      timestamp: Date.now(),
      projectSlug,
    };
  }
}
```

### Step 2 — Register in `GoalEvaluatorPlugin`

In `src/plugins/goal_evaluator_plugin.ts`, import and add to the evaluator dispatch:

```typescript
import { CrossDomainEvaluator } from "../evaluators/cross_domain_evaluator.ts";

// Add as a class field:
private crossDomainEvaluator = new CrossDomainEvaluator();

// In evaluateState(), extend the switch:
} else if (goal.type === "CrossDomain") {
  violation = this.crossDomainEvaluator.evaluate(goal as CrossDomainGoal, state, projectSlug);
}
```

### Step 3 — Add `type: CrossDomain` to `goals.yaml`

```yaml
  - id: infra.healthy-ratio
    type: CrossDomain
    description: Healthy nodes must outnumber degraded nodes 2:1
    severity: high
    selectorA: "domains.infra.data.nodes.0.cpu"   # numerator
    selectorB: "domains.infra.data.nodes.1.cpu"   # denominator
    operator: ratio_lt
    threshold: 0.5
```

### Verify it works

```
[goal-evaluator] Loaded 5 goal(s) from global
```

Check that no TypeScript errors appear on build:

```bash
pnpm run build
```

---

## 6. Write a ceremony

**When to use this:** You want to schedule a recurring fleet operation (daily standup, weekly review, health check) that invokes an agent skill on a cron schedule.

### Step 1 — Create `workspace/ceremonies/{name}.yaml`

```yaml
# workspace/ceremonies/infra-health-check.yaml

id: infra.health-check           # unique identifier — used in bus topics
name: Infra Health Check         # human-readable label
schedule: "0 * * * *"           # cron expression (UTC) — every hour
skill: infra_health_check        # agent skill to invoke
targets:
  - all                          # 'all' or a list of project paths
notifyChannel: ops-alerts        # Discord channel slug (omit to skip notifications)
enabled: true                    # default: true
```

CeremonyPlugin polls for new/changed files every 5 seconds — no restart needed.

### Step 2 — Implement the skill in the target agent (if needed)

If the skill doesn't exist yet, add it to the agent's skill registry. The skill receives a context object and must publish a response on `agent.skill.response.{runId}`.

### Step 3 — Verify it loads

Check the logs after saving the file:

```
Scheduled ceremony infra.health-check at 2026-04-08T01:00:00.000Z
```

### Reference

See [`workspace/ceremonies/daily-standup.yaml`](../../workspace/ceremonies/daily-standup.yaml) for a working example.

Full ceremony schema and bus topics: [`reference/ceremony-plugin.md`](../reference/ceremony-plugin.md).

How to trigger a ceremony manually: see [How to Create a Ceremony](./create-a-ceremony.md#how-to-test-a-ceremony-manually).

### Verify it works

```
Scheduled ceremony infra.health-check at {next fire time}
```

After the cron fires:

```
[ceremony-plugin] Running ceremony "infra.health-check"
[ceremony-plugin] Ceremony "infra.health-check" completed: success
```

---

## 7. Reference: topic map

The World Engine message flow from collection through to outcome:

| Stage | Component | Topic (outbound) | Description |
|-------|-----------|-----------------|-------------|
| **Collect** | `WorldStateCollectorPlugin` | _(internal tick)_ | Polls APIs, writes to Redis + knowledge.db |
| **Query** | Any consumer | `tool.world_state.get` → reply | Request current world state snapshot |
| **Evaluate** | `GoalEvaluatorPlugin` | `world.goal.violated` | Emitted when a goal condition is breached |
| **Plan** | `PlannerPluginL0` | `world.action.planned` | L0 matches action to violation |
| **Dispatch** | `ActionDispatcherPlugin` | _(action `meta.topic`)_ | Publishes to the topic defined in `actions.yaml` |
| **Handle** | Agent (e.g. Ava) | `message.outbound.discord.*` | Executes the action — sends alert, triggers ceremony, etc. |
| **Snapshot** | `CeremonyStateExtension` (and others) | `world.state.snapshot` | Extensions publish state updates back to the bus |

When adding a new component, subscribe to the topic immediately upstream and publish to the topic immediately downstream. For most new domains: collect → publish `world.state.updated`. For new actions: subscribe to `world.goal.violated` → publish to your `meta.topic`.

---

## Related docs

- [`reference/world-engine.md`](../reference/world-engine.md) — full schemas, goal types, escalation ladder, bus topics
- [`reference/ceremony-plugin.md`](../reference/ceremony-plugin.md) — ceremony schema and lifecycle
- [`reference/bus-topics.md`](../reference/bus-topics.md) — all bus topics across all plugins
- [`explanation/world-engine-concepts.md`](../explanation/world-engine-concepts.md) — why the World Engine is designed this way
- [`how-to/create-a-ceremony.md`](./create-a-ceremony.md) — step-by-step ceremony setup

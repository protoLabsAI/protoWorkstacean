---
title: L2 Planner API Reference
---


## L2Dispatcher

Main entry point for the planning pipeline.

```typescript
import { L2Dispatcher } from "./src/planner/dispatcher.ts";
import { ActionGraph } from "./src/planner/action-graph.ts";

const graph = new ActionGraph();
graph.addActions([...]);

const dispatcher = new L2Dispatcher(graph, {
  routing: { l2ConfidenceThreshold: 0.5 },
  a2aClient: myA2AClient,
  onL3Escalation: (ctx, result) => { /* handle escalation */ },
});

const result = await dispatcher.resolve(state, goal, namedGoal);
```

### L2Result

```typescript
interface L2Result {
  success: boolean;
  plan?: Plan;
  confidence: ConfidenceScore;
  escalatedToL3: boolean;
  error?: string;
  planId: string;
}
```

## A2AClient Interface

Implement this to connect Ava (or any LLM) to the hybrid planner.

```typescript
interface A2AClient {
  proposePlans(prompt: A2APrompt, maxCandidates: number): Promise<CandidatePlan[]>;
}
```

## RoutingConfig

```typescript
interface RoutingConfig {
  l0ConfidenceThreshold: number;  // default: 0.7
  l1ConfidenceThreshold: number;  // default: 0.6
  l2ConfidenceThreshold: number;  // default: 0.5
  maxCandidates: number;          // default: 3
  l2TimeBudgetMs: number;         // default: 30000
  tryL1BeforeL2: boolean;         // default: true
}
```

## Metrics API

```typescript
const metrics = dispatcher.getMetrics();
const summary = metrics.getSummary(3600_000); // last hour
console.log(summary.escalationRate);
console.log(summary.successRate);
```

## Learning Registry

```typescript
const registry = dispatcher.getRuleRegistry();
const stats = registry.getStats();
console.log(stats.totalRules, stats.promotedRules);
```

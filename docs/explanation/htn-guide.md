---
title: HTN Decomposition Guide
---

## Hierarchy Levels

The HTN system decomposes tasks through four levels:

| Level | Description | Example |
|-------|-------------|---------|
| portfolio | Strategic workspace tasks | "Improve portfolio health" |
| project | Project-scoped tasks | "Stabilize CI pipeline" |
| domain | Domain-specific tasks | "Restart failing service" |
| action | Primitive executable actions | "Set service.status = healthy" |

## Defining Tasks

### Primitive Actions

```ts
import { action } from "../src/planner/action.ts";

const restart = action("restart", "restart-service")
  .level("action")
  .requireEquals("service.status", "down")
  .set({ "service.status": "healthy" })
  .cost(2)
  .build();
```

### Composite Tasks

```ts
import type { CompositeTask } from "../src/planner/types.ts";

const fixService: CompositeTask = {
  id: "fix-service",
  name: "Fix Service",
  level: "domain",
  precondition: (state) => state["service.status"] === "down",
  decompose: (state) => ["restart", "verify-health"],
};
```

## Building the Task Network

```ts
import { TaskNetwork } from "../src/planner/task-network.ts";

const network = new TaskNetwork();
network.addPrimitiveAction(restart);
network.addPrimitiveAction(verifyHealth);
network.addCompositeTask(fixService);
```

## Running Decomposition

```ts
import { HTNDecomposer } from "../src/planner/htn-decomposer.ts";

const decomposer = new HTNDecomposer(network);
const result = decomposer.decompose("fix-service", currentState);

if (result.success) {
  // result.actions contains ordered primitive actions
}
```

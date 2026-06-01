---
tags: [api]
summary: api implementation decisions and patterns
relevantTo: [api]
importance: 0.7
relatedFiles: []
usageStats:
  loaded: 2
  referenced: 0
  successfulFeatures: 0
---
# api

#### [Pattern] Using a WeakMap within the Registry to track in-flight execution counts per IExecutor instance. (2026-06-01)
- **Problem solved:** The registry needs to know how many active requests are currently being handled by a specific executor instance to determine when it is safe to call `dispose()`.
- **Why this works:** Using a WeakMap prevents memory leaks because the entry is automatically garbage collected once the executor instance itself is no longer referenced, avoiding the need for manual cleanup of the counter map.
- **Trade-offs:** Provides automatic memory management at the cost of slightly more complex debugging if one needs to inspect the registry state (as WeakMap contents aren't enumerable).
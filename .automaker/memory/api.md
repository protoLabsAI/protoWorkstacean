---
tags: [api]
summary: api implementation decisions and patterns
relevantTo: [api]
importance: 0.7
relatedFiles: []
usageStats:
  loaded: 7
  referenced: 3
  successfulFeatures: 3
---
# api

#### [Pattern] Using a WeakMap within the Registry to track in-flight execution counts per IExecutor instance. (2026-06-01)
- **Problem solved:** The registry needs to know how many active requests are currently being handled by a specific executor instance to determine when it is safe to call `dispose()`.
- **Why this works:** Using a WeakMap prevents memory leaks because the entry is automatically garbage collected once the executor instance itself is no longer referenced, avoiding the need for manual cleanup of the counter map.
- **Trade-offs:** Provides automatic memory management at the cost of slightly more complex debugging if one needs to inspect the registry state (as WeakMap contents aren't enumerable).

### Implementation of distinct dedup key prefixes (`ci-review:` vs `pr-review:`) for different trigger types. (2026-06-01)
- **Context:** Preventing race conditions or duplicate review actions when a PR review is triggered by both a code commit and a CI completion event.
- **Why:** Ensures that the state machine can distinguish between a review initiated by developer activity (commit) and one initiated by automated infrastructure (CI), allowing them to coexist or transition without colliding in the deduplication logic.
- **Rejected:** Using a single unified dedup key based only on the PR number/SHA.
- **Trade-offs:** Increases complexity in the key generation logic but provides granular control over which event type 'owns' the current review cycle.
- **Breaking if changed:** If prefixes are merged, a CI completion might inadvertently suppress a manual re-review or vice versa due to key collision.

### Use a specific `ci-review:` prefix for the deduplication key when re-dispatching reviews via CI completion events. (2026-06-01)
- **Context:** The system needs to trigger an automatic review after CI passes, but must avoid infinite loops or colliding with standard PR review triggers.
- **Why:** It distinguishes between a review triggered by a manual/standard PR event and one triggered specifically by a CI status change, allowing for granular control over which logic applies to which trigger.
- **Rejected:** Using the same `pr-review:` prefix as standard PR reviews.
- **Trade-offs:** Adds slight complexity to the key management but provides much higher observability and prevents collision-based logic errors.
- **Breaking if changed:** If removed, the system might lose the ability to differentiate why a review was triggered, potentially leading to duplicate processing or inability to apply CI-specific logic.
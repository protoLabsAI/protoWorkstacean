---
tags: [api]
summary: api implementation decisions and patterns
relevantTo: [api]
importance: 0.7
relatedFiles: []
usageStats:
  loaded: 10
  referenced: 7
  successfulFeatures: 7
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

### Use of a specific 'ci-review:' dedup prefix for auto-generated reviews. (2026-06-01)
- **Context:** Automated re-triggering of PR reviews via CI completion webhooks (workflow_run/check_suite).
- **Why:** To prevent infinite loops and collisions between manual 'pr-review:' triggers and automated 'ci-review:' triggers during the same lifecycle.
- **Rejected:** Using the standard 'pr-review:' prefix for both manual and automated triggers.
- **Trade-offs:** Adds complexity to the deduplication logic but provides granular control over which type of review is being suppressed or allowed.
- **Breaking if changed:** Removing the unique prefix would cause the system to incorrectly identify automated CI reviews as manual ones, potentially blocking legitimate subsequent reviews.

### Filtering webhook triggers based on a 'TERMINAL_CONCLUSIONS' set. (2026-06-01)
- **Context:** Determining whether a CI run result should trigger a formal Quinn review.
- **Why:** Not all workflow completions are meaningful for a code review (e.g., linting failures vs. successful test suites). Only specific terminal states represent a valid state for re-evaluation.
- **Rejected:** Triggering a review on any 'completed' status regardless of the outcome or type.
- **Trade-offs:** Harder to maintain as new CI tools are added, but prevents noise and unnecessary automated comments.
- **Breaking if changed:** Changing this set without updating CI configurations could lead to 'silent' successes where CI passes but no review is ever triggered.

### Implementation of a Management API for runtime control (reload/unregister) and diagnostics. (2026-06-02)
- **Context:** Need for operational control over dynamic agent lifecycles without full system restarts.
- **Why:** Decouples the management of individual agents from the main process lifecycle, allowing hot-reloading of specific plugins/agents.
- **Rejected:** Restarting the entire service for configuration or plugin changes.
- **Trade-offs:** Increases complexity of the API surface but provides much higher availability during development and production tuning.
- **Breaking if changed:** Removing these endpoints would force manual service restarts to apply any agent-level changes.

### Implement a transparent, tiered authentication fallback mechanism (App Token -> PAT). (2026-06-02)
- **Context:** The system needed to resolve CI status visibility issues without requiring immediate reconfiguration of the GitHub App.
- **Why:** This allows the system to remain functional during the transition period while the App permissions are being updated, providing a graceful degradation/recovery path.
- **Rejected:** Requiring manual intervention or failing immediately upon the first 403 was rejected because it blocks the automated review workflow.
- **Trade-offs:** Easier deployment and higher availability; harder to debug if the logs don't explicitly state that a fallback occurred.
- **Breaking if changed:** Changing the order (PAT first) would increase latency for the standard operating mode and potentially use more privileged credentials than necessary for routine tasks.

### Utilizing GitHub Rulesets API instead of the legacy Branch Protection API. (2026-06-02)
- **Context:** Configuring mandatory review requirements for the main branch in protoMaker.
- **Why:** Rulesets provide more granular control and are the modern replacement for branch protection, allowing for better enforcement through 'required_reviewer_ids'.
- **Rejected:** Legacy Branch Protection API; rejected because it is being phased out and rulesets offer superior targeting (e.g., via conditions).
- **Trade-offs:** Rulesets require a different payload structure and endpoint compared to established branch protection scripts.
- **Breaking if changed:** Changing back to branch protection might lose the ability to specifically target Quinn via App ID within the rule parameters.

### Exposing static constants by removing 'private' visibility for testability (2026-06-02)
- **Context:** A unit test was attempting to access a private static property `TERMINAL_CONCLUSIONS` in `GitHubPlugin` to verify CI state transitions.
- **Why:** Removing the `private` modifier on a `static readonly` constant is a pragmatic way to allow package-level testing without adding complex getter methods or changing the object's internal state management. Since the set represents a fixed domain contract rather than mutable state, it doesn't violate encapsulation principles as severely as exposing instance variables.
- **Breaking if changed:** If this were a mutable property instead of `readonly`, removing `private` would expose the internal state to unintended modification by consumers.

#### [Gotcha] Partial implementation of fallback mechanisms can create 'silent' failure paths where one part of a dependency chain works while another fails. (2026-06-02)
- **Situation:** The PAT (Personal Access Token) fallback was implemented for the GitHub Check Runs endpoint but omitted for the PR Detail endpoint.
- **Root cause:** The App token would fail with a 403 on the PR detail fetch (needed to resolve the head SHA), causing the entire CI inspection process to crash before it ever reached the endpoint that actually had the fallback logic.

### Mandatory projectPath propagation in multi-tenant/multi-repo orchestration (2026-06-02)
- **Context:** The `pr-remediator` tool calls must explicitly pass `projectPath` extracted from metadata.
- **Why:** To prevent 'context bleeding' where an agent operating on one repository accidentally executes tools against the orchestrator's own codebase or a default project path.
- **Rejected:** Assuming the agent can resolve the target project path based on the repository name alone.
- **Trade-offs:** Requires more rigorous metadata management at the dispatch layer, but provides strict isolation between different target projects.
- **Breaking if changed:** Removing `projectPath` from tool call requirements would allow agents to execute commands in the wrong working directory, potentially corrupting the orchestrator's environment.
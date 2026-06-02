---
tags: [gotchas]
summary: gotchas implementation decisions and patterns
relevantTo: [gotchas]
importance: 0.7
relatedFiles: []
usageStats:
  loaded: 85
  referenced: 11
  successfulFeatures: 11
---
# gotchas

#### [Gotcha] Single-label DNS hostnames cannot reliably indicate network topology — multiple isolated networks can share identical naming patterns (2026-04-20)
- **Situation:** Original callback URL heuristic assumed single-label hostnames (e.g., 'steamdeck') were exclusively docker-internal, but Tailscale mesh networking also uses single-label DNS for external VPN devices, causing misclassification
- **Root cause:** Docker-internal networks and Tailscale VPN both opt for non-FQDN naming conventions; hostname patterns alone are insufficient to disambiguate network boundaries
- **How to avoid:** Simple heuristic fails when a second network topology introduces the same naming pattern

#### [Gotcha] The necessity of differentiating between 'detecting' a change and 'applying' a change in the AgentRuntimePlugin. (2026-06-01)
- **Situation:** Initial implementation of workspace watchers often only detects that a file changed, but doesn't handle the complex state transition of removing old registrations and adding new ones.
- **Root cause:** A simple 'reload all' approach is inefficient and disruptive; a 'diff-and-apply' approach minimizes the impact on the running system by only touching the specific agents that changed.
- **How to avoid:** Requires maintaining a hash or version of the agent definition to perform effective diffing.

#### [Gotcha] Distinction between 'Registered Agents' and 'Synthetic Actors' in telemetry attribution. (2026-06-01)
- **Situation:** Handling outcomes where the `systemActor` is not found in the `ExecutorRegistry`.
- **Root cause:** Some system components act as actors but aren't formal executors. The implementation explicitly detects these 'synthetic actors', logs a warning once to prevent log flooding, and routes them to a separate `systemActorWindows` collection rather than the standard `agentWindows`.
- **How to avoid:** Requires maintaining two separate Map collections in memory, but ensures high signal-to-noise ratio in agent health dashboards.

#### [Gotcha] The necessity of a 'Stale SHA guard' during CI webhook handling. (2026-06-01)
- **Situation:** In active development, a developer might push a new commit while a CI run for an older commit is still finishing.
- **Root cause:** Webhooks for older commits can arrive late. If the system processes a 'success' for an old SHA, it might attempt to review a PR that has already moved forward, causing context mismatch.
- **How to avoid:** Increases implementation complexity by requiring SHA verification against the current PR head, but ensures review accuracy.

#### [Gotcha] Type mismatch between registration metadata (string | undefined) and internal mapping keys (string). (2026-06-02)
- **Situation:** The `byAgent` map uses a fallback key `__anonymous__` for undefined agent names, but the registration object itself still carries the `undefined` type.
- **Root cause:** The internal implementation logic handles the nullability by providing a default string, but the TypeScript compiler enforces strict type safety on the original property.
- **How to avoid:** Requires explicit handling of the fallback key in both the insertion and retrieval logic to maintain type safety.

#### [Gotcha] Type mismatch in array push operations involving nullable strings (2026-06-02)
- **Situation:** In `executor-registry.ts`, a loop was pushing `r.skill` (which could be `string | null`) into `removedSkills` (a `string[]`).
- **Root cause:** TypeScript's strict null checks prevent pushing nullable types into non-nullable arrays, which often occurs when registry metadata is partially populated or optional.

#### [Gotcha] Async/Await mismatch during synchronous-to-asynchronous refactoring of dispatchers (2026-06-02)
- **Situation:** Refactoring `_dispatchToAva` from a synchronous return of a correlation ID to an asynchronous operation returning a Promise.
- **Root cause:** When transitioning from a fire-and-forget pattern to a reliable awaitable pattern, all upstream callers (like `_handleDiagnoseResponse`) must be verified as `async`. Failure to do so results in unhandled promise rejections or race conditions where `_recordDispatch` executes before the dispatch actually succeeds.
- **How to avoid:** Makes the control flow harder to reason about if not properly awaited, but allows for robust error handling and guaranteed order of operations (Dispatch -> Record).
---
tags: [architecture]
summary: architecture implementation decisions and patterns
relevantTo: [architecture]
importance: 0.7
relatedFiles: []
usageStats:
  loaded: 19
  referenced: 3
  successfulFeatures: 3
---
# architecture

#### [Gotcha] Hostname parsing heuristic fails when agents operate across different network namespaces (Tailscale vs direct network). Single-label hostname format is not uniform across network topologies. (2026-04-20)
- **Situation:** The original _pickCallbackBaseUrl used hostname parsing to derive callback base URL, assuming all agents were on the same network topology. Tailscale agents have different hostname structure, breaking the heuristic.
- **Root cause:** Network topology fundamentally changes hostname resolution patterns. Tailscale overlays a different namespace where the assumptions about hostname structure no longer hold. Cannot reliably infer network topology from hostname alone.
- **How to avoid:** Required explicit configuration instead of inferring from agent properties, but eliminated a class of hard-to-debug network connectivity failures.

### Use explicit `external: boolean` flag in agent configuration rather than attempting automatic detection of Tailscale/external agents. (2026-04-20)
- **Context:** Needed to support agents that operate in different network namespaces where the hostname heuristic doesn't apply.
- **Why:** Network topology is a deployment-time concern. Explicit configuration is clearer, testable, and doesn't require fragile runtime detection logic. Treats network configuration as data, not magic.
- **Rejected:** Auto-detection based on agent name, domain suffix, or other heuristics would create implicit behavior that's hard to debug and couples agent identity to network topology.
- **Trade-offs:** Requires manual configuration per external agent, but avoids special cases in routing logic and makes network topology explicit and debuggable.
- **Breaking if changed:** Removing the external flag check in _pickCallbackBaseUrl forces all agents through the hostname heuristic, breaking Tailscale connectivity. Adding new external agents requires explicit configuration.

#### [Pattern] Push configuration through multiple layers: deployment config (agents.yaml) → agent config class (A2AAgentConfig) → executor (A2AExecutor getter) → dispatcher logic (_pickCallbackBaseUrl). (2026-04-20)
- **Problem solved:** The external flag flows from yaml through TypeScript config to execution logic, with each layer exposing what it needs.
- **Why this works:** Separates concerns: deployment configuration is independent of business logic. Each layer exposes only what it uses. Makes it easy to trace how a configuration option affects behavior.
- **Trade-offs:** Requires maintaining field definitions across multiple classes, but makes configuration flow explicit and auditable.

#### [Gotcha] Single-label hostname heuristic for callback URLs breaks when agents have different network access patterns than the controller (Tailscale external agents) (2026-04-20)
- **Situation:** Push notification routing assumed controller and agent see the same hostname resolution. Tailscale steamdeck agent externally routed cannot resolve internal-only hostnames.
- **Root cause:** Network topology determines whether a hostname is resolvable. A heuristic that works for co-located agents fails for agents with external IP access patterns.
- **How to avoid:** Moved complexity from implicit detection to explicit configuration. Less magic, but requires operator knowledge of network topology.

### Callback URL routing uses explicit topology flag (external: boolean) rather than inferred from agent properties (2026-04-20)
- **Context:** Multiple agents in different network positions (internal vs. Tailscale external) need different callback strategies
- **Why:** Operator declaratively knows whether an agent is external. Prevents fragile heuristics and keeps routing logic deterministic.
- **Rejected:** Dynamic detection via probe requests (latency cost, race conditions); detection via DNS reverse-lookup (environment-specific)
- **Trade-offs:** Requires YAML configuration maintenance but eliminates implicit magic. Configuration intent is explicit and auditable.
- **Breaking if changed:** Removing the flag disables the capability to override routing per-agent; agents must then use auto-detected heuristics which fail for external Tailscale.

#### [Pattern] Conditional callback URL selection: _pickCallbackBaseUrl() short-circuits to WORKSTACEAN_BASE_URL when external=true, bypassing hostname heuristic (2026-04-20)
- **Problem solved:** Controller exposes callback URL via both internal hostname (heuristic) and fully-qualified base URL (external). Agents need path chosen by topology.
- **Why this works:** External agents require absolute URL with proper DNS resolution. Heuristic is optimization for internal agents. Conditional selection keeps both strategies available without collision.
- **Trade-offs:** Added conditional branch in routing logic. Simpler than topology auto-detection, more explicit than pure heuristic.

### Network topology declared explicitly in configuration (agents.yaml external flag) rather than inferred from hostname heuristics (2026-04-20)
- **Context:** Push-notification callback routing must correctly reach agents deployed in different network contexts; hostname-based heuristic approach failed for Tailscale agents
- **Why:** Topology is operational metadata subject to deployment changes, not a code invariant; explicit configuration is more reliable and maintainable than hostname-pattern heuristics that depend on implicit assumptions
- **Rejected:** Enhanced pattern matching (e.g., Tailscale device detection rules) — still vulnerable to breaking with future topology changes; hardcoded agent lists — doesn't scale
- **Trade-offs:** Easier: correct routing, self-documenting, ops-team can update without code changes. Harder: configuration drift risk, no automatic topology detection
- **Breaking if changed:** Removing the external flag and reverting to hostname heuristics will re-break Tailscale agent routing

#### [Pattern] Configuration-driven short-circuit: explicit operational metadata bypasses code heuristics entirely without fallback (2026-04-20)
- **Problem solved:** System has both heuristic-based fallback path and explicit configuration; when external=true, uses WORKSTACEAN_BASE_URL without attempting hostname analysis
- **Why this works:** Operator knows topology better than code; explicit config should be unambiguous and fully trusted rather than merged with heuristic logic
- **Trade-offs:** Easier: clear semantics and single decision point. Harder: requires accurate configuration; no automatic detection or intelligent fallback

### Implementing a 'drain-and-dispose' lifecycle for hot-reloading agents via an in-flight tracking mechanism in the ExecutorRegistry. (2026-06-01)
- **Context:** Hot-reloading agent configurations (agents.yaml) requires replacing executors without dropping active skill dispatches or causing resource leaks.
- **Why:** To ensure zero-downtime updates and graceful shutdown of old executor instances while allowing current requests to complete naturally.
- **Rejected:** Immediate replacement of executors, which would cause in-flight requests to fail with 'executor not found' or 'connection closed' errors.
- **Trade-offs:** Increases complexity by requiring a WeakMap for in-flight counting and adding asynchronous waiting logic to the unregistration process; however, it provides much higher system stability during configuration changes.
- **Breaking if changed:** Removing the `unregisterAgent` drain logic or the `dispose()` hook would lead to either interrupted user requests or leaked resources (e.g., open sockets/processes) from old executors.

### Implementation of a durable, unified live state using a repository pattern for plugin hydration. (2026-06-01)
- **Context:** The AgentFleetHealthPlugin needed to maintain rolling 24h windows of agent performance (success/latency/cost) but would lose this data on restart.
- **Why:** By introducing `FleetStateRepository` backed by `knowledge.db`, the system can hydrate in-memory Maps during the `install()` phase, ensuring continuity of telemetry without requiring a full historical replay of all events.
- **Rejected:** Relying solely on in-memory state (lost on restart) or querying a full historical database on every request (too slow for real-time rollups).
- **Trade-offs:** Increases complexity by requiring a dual-write strategy (in-memory window + durable store) and a hydration step at startup, but provides near-instantaneous read access to recent history.
- **Breaking if changed:** Removing the hydration logic causes 'blind spots' in telemetry every time the service restarts; removing the repository prevents persistence entirely.

#### [Pattern] Graceful degradation of durable storage in plugins. (2026-06-01)
- **Problem solved:** The `AgentFleetHealthPlugin` depends on `fleetStateRepo` for persistence.
- **Why this works:** The implementation uses an optional dependency (`private readonly fleetStateRepo?: FleetStateRepository`) and checks for its existence before attempting writes or hydration. This allows the plugin to function as a purely in-memory aggregator if the database layer is unavailable or not configured.
- **Trade-offs:** Makes the code slightly more defensive with null checks, but significantly increases the portability and testability of the plugin.

### Transitioning from a 'hold' state (COMMENT only) to a 're-dispatch' model upon terminal CI conclusions. (2026-06-01)
- **Context:** The system was previously holding verdicts in a provisional COMMENT state while CI was running, but lacked a mechanism to upgrade these to formal APPROVE/REQUEST_CHANGES once CI finished.
- **Why:** To solve the 'stalled PR' problem where automation would provide feedback but never finalize the review process after the environment was validated.
- **Rejected:** Polling CI status from the agent side.
- **Trade-offs:** Requires handling specific webhook events (`check_suite.completed`, `workflow_run.completed`) and mapping SHAs to open PRs, which increases integration surface area compared to simple polling.
- **Breaking if changed:** Removing this logic reverts the system to a purely advisory role where it can never formally pass a PR through a gate automatically.
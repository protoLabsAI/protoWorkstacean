---
tags: [gotchas]
summary: gotchas implementation decisions and patterns
relevantTo: [gotchas]
importance: 0.7
relatedFiles: []
usageStats:
  loaded: 72
  referenced: 0
  successfulFeatures: 0
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
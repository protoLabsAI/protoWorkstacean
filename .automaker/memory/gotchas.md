---
tags: [gotchas]
summary: gotchas implementation decisions and patterns
relevantTo: [gotchas]
importance: 0.7
relatedFiles: []
usageStats:
  loaded: 70
  referenced: 0
  successfulFeatures: 0
---
# gotchas

#### [Gotcha] Single-label DNS hostnames cannot reliably indicate network topology — multiple isolated networks can share identical naming patterns (2026-04-20)
- **Situation:** Original callback URL heuristic assumed single-label hostnames (e.g., 'steamdeck') were exclusively docker-internal, but Tailscale mesh networking also uses single-label DNS for external VPN devices, causing misclassification
- **Root cause:** Docker-internal networks and Tailscale VPN both opt for non-FQDN naming conventions; hostname patterns alone are insufficient to disambiguate network boundaries
- **How to avoid:** Simple heuristic fails when a second network topology introduces the same naming pattern
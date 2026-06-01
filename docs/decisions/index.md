---
title: Decisions (ADRs)
---

Architecture Decision Records — the load-bearing choices about *where protoLabs is heading*, written down so they don't have to be re-litigated. Each ADR captures the context at decision time, the decision itself, and the consequences we accepted.

These are cross-system by nature: protoLabs is a fleet (protoWorkstacean, protoMaker, protoContent, the agents), and the decisions here define how the pieces fit. They live in protoWorkstacean's docs because it's the switchboard — the hub the contracts pass through — but they bind the whole fleet.

| ADR | Decision |
|-----|----------|
| [ADR-0001](./0001-org-to-execution-pipeline) | The org→execution pipeline: Linear → Ava → protoMaker → execution, with two coexisting intakes. Ava forwards; protoMaker decomposes. |
| [ADR-0002](./0002-workstacean-protomaker-integration-boundary) | protoWorkstacean ↔ protoMaker talk over HTTP + webhooks + bus `/publish`, never A2A. |
| [ADR-0003](./0003-content-surfacing-into-protocontent) | protoWorkstacean *surfaces* content ideas from fleet lifecycle events; protoContent authors. `release.published` is the first tap. |
| [ADR-0004](./0004-fleet-control-plane-and-hot-swappable-extension) | A fleet **control plane**: hot-reloadable file-backed registries + a write API + a separate management surface. Extend via external agents (A2A) / MCP / declarative rituals — never hot-loaded in-process code. Durable, unified live state. |

## Status legend

- **Accepted** — decided and in effect; build to it.
- **Proposed** — drafted, not yet ratified.
- **Superseded** — replaced by a later ADR (linked).

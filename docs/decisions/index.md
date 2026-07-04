---
title: Decisions (ADRs)
---

Architecture Decision Records — the load-bearing choices about *where protoLabs is heading*, written down so they don't have to be re-litigated. Each ADR captures the context at decision time, the decision itself, and the consequences we accepted.

These are cross-system by nature: protoLabs is a fleet (protoWorkstacean, protoContent, the agents), and the decisions here define how the pieces fit. They live in protoWorkstacean's docs because it's the switchboard — the hub the contracts pass through — but they bind the whole fleet.

| ADR | Status | Decision |
|-----|--------|----------|
| [ADR-0001](./0001-org-to-execution-pipeline) | Superseded | The org→execution pipeline through the board service, with two coexisting intakes. Superseded — the board service was decommissioned (2026-07-03). |
| [ADR-0002](./0002-workstacean-protomaker-integration-boundary) | Superseded | The integration boundary between the switchboard and the board service (HTTP + webhooks + bus `/publish`, never A2A). Superseded — the board service was decommissioned (2026-07-03). |
| [ADR-0003](./0003-content-surfacing-into-protocontent) | Accepted | protoWorkstacean *surfaces* content ideas from fleet lifecycle events; protoContent authors. `release.published` is the first tap. |
| [ADR-0004](./0004-fleet-control-plane-and-hot-swappable-extension) | Accepted | A fleet **control plane**: hot-reloadable file-backed registries + a write API + a separate management surface. Extend via external agents (A2A) / MCP / declarative rituals — never hot-loaded in-process code. Durable, unified live state. |
| [ADR-0005](./0005-mcp-client-tier-and-trust-tiers) | Accepted | The **MCP client tier** (ADR-0004's P4 slice): register MCP servers via the control plane → their tools become fleet executors. Trust tiers gate auto-enable; capability grants are audit-only in v1. Retire the broken `workspace/plugins/*.ts` loader. |
| [ADR-0006](./0006-a2a-1.0-canonical-sdks-and-protolabs-conventions-layer) | Accepted | Migrate the whole fleet to **A2A 1.0** by adopting the canonical SDK per language + a thin shared conventions layer — deleting the hand-rolled handlers. Reference-grade. |
| [ADR-0007](./0007-workstacean-as-fleet-a2a-gateway) | Accepted | **workstacean is the fleet's A2A gateway**: every agent (in-process + remote) addressable through one front door at `/a2a/<agent>` with a per-agent card; route to executor or transparently proxy. Dual gateway (A2A=agents, MCP=tools). |
| [ADR-0008](./0008-visual-orchestration-surface-for-the-fleet) | Accepted | The **visual orchestration surface** — "ComfyUI/n8n of agent orchestration." **One command hub**: workstacean commands every agent — built-in (in-process) + distributed A2A (via the ADR-0007 gateway). Take the UX (live canvas, node palette, wiring, rendered workflows), keep **choreography** (nodes are reasoning agents, not data-flow boxes). One bus, no federation. Reframes ADR-0004 §8. |

## Status legend

- **Accepted** — decided and in effect; build to it.
- **Proposed** — drafted, not yet ratified.
- **Superseded** — replaced by a later ADR (linked).

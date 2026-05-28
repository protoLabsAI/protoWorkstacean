---
title: "ADR-0002: protoWorkstacean ↔ protoMaker integration boundary"
---

# ADR-0002: protoWorkstacean ↔ protoMaker integration boundary

- **Status:** Accepted — 2026-05-27
- **Deciders:** Josh (operator)
- **Related:** [ADR-0001](./0001-org-to-execution-pipeline), protoMaker#3975

## Context

protoMaker advertises an A2A agent card, so protoWorkstacean's SkillBroker auto-discovered its skills and registered A2A executors for them. But protoMaker **serves no `/a2a` JSON-RPC endpoint** — `/a2a` returns 404, and the card's advertised URL (`ava:3008/a2a`) resolves to the protoWorkstacean container itself. So every workstacean→protoMaker A2A dispatch failed silently:

- the `board.health` ceremony failed every 30 min (since retired),
- the Linear→protoMaker `manage_feature` bridge never delivered,
- a dead `bug_triage` A2A executor shadowed Quinn's working in-process one via health-weighted resolution.

We need a durable contract for how the two systems talk, before building the [ADR-0001](./0001-org-to-execution-pipeline) intakes on top of it.

## Decision

**protoWorkstacean ↔ protoMaker communicate over HTTP + GitHub webhooks + bus `POST /publish`. Never A2A. There is no skill-dispatch chain from protoWorkstacean into protoMaker's agents.**

- **protoWorkstacean → protoMaker:**
  - *Create-project intake* — Ava calls a protoMaker HTTP endpoint to start the create-project → decompose flow (ADR-0001, initiative-level).
  - *GitHub issues* — protoMaker ingests issues via GitHub's native webhooks (ADR-0001, issue-level; protoMaker#3975).
- **protoMaker → protoWorkstacean:**
  - Lifecycle events via `POST /publish` (`feature.completed` / `feature.failed`), consumed by `feature-notifier` + the Linear bridge.
- **Reads:** protoWorkstacean polls protoMaker `GET /api/settings/global` for the project registry (the source of truth for projects).
- **protoMaker owns its own execution** — Roxy and proto run inside protoMaker. protoWorkstacean does not dispatch into them.

**Retirements that follow from this:**

- Remove the dead `protomaker` A2A entry from `workspace/agents.yaml` (stops the dead-executor pollution + the `bug_triage` shadow).
- Retire the `linear-protomaker-bridge` `manage_feature` A2A dispatch — superseded by issue ingestion + the create-project intake. Keep the reverse `feature.completed` / `feature.failed` consumer.

## Consequences

- No more dead A2A pollution; contracts are explicit and each side is self-contained (protoMaker resolves its own repo→project routing from its own `.automaker/settings.json`, not from a protoWorkstacean file).
- This **decides the open question on the bridge**: retire it, do *not* rebuild `manage_feature` over HTTP — the two ADR-0001 intakes replace it.
- Aligns with the broader "no dispatch chain to protoMaker" direction. If multi-node messaging is ever needed, that's a bus-bridge concern, not a reason to revive A2A here.

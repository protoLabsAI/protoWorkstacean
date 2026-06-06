---
title: Architecture — Flow Reference
---

_Architectural deep-dives for every flow in protoWorkstacean. The complement to [CLAUDE.md](https://github.com/protoLabsAI/protoWorkstacean/blob/main/CLAUDE.md): CLAUDE.md tells you what the system **is**; this section tells you what it **does**, one flow at a time._

---

## What's in here

Ten flows + one cross-cut. Each doc has the same shape:

- **What & why** — one paragraph
- **ASCII spine** — terminal-readable shape of the flow
- **Mermaid sequence** — exact bus topics + plugin participation
- **Topic table** — what each topic is, who publishes, who subscribes
- **Failure modes & gotchas** — what happens when things break

---

## The spine — every flow lives on it

```
                                                                  ┌────────────────────┐
                                                                  │   workspace/*.yaml │
                                                                  │  (channels, agents,│
                                                                  │   ceremonies, …)   │
                                                                  └─────────┬──────────┘
                                                                            │ declarative config
                                                                            ▼
   ┌──────────────┐    message.inbound.*    ┌──────────┐  agent.skill.request   ┌──────────────┐
   │  TRIGGERS    │ ─────────────────────►  │  ROUTER  │ ─────────────────────► │  DISPATCHER  │
   │              │                         │          │                        │ (chokepoint) │
   │ Discord      │                         │ keyword/ │                        │              │
   │ GitHub       │                         │ channel  │                        │ • cooldown   │
   │ Linear       │                         │ → skill  │                        │ • registry   │
   │ Google       │                         │          │                        │ • outcome    │
   │ Scheduler    │ ── cron.* ──────────────┴──────────┘                        │   publish    │
   │ Ceremonies   │ ── ceremony.{id}.execute ───────────────────────────────────┤              │
   │ Alerts       │ ── action.* ───────────────────────────────────────────────┘              │
   └──────────────┘                                                              └──────┬───────┘
                                                                                        │ dispatch
                                                                                        ▼
                                                                            ┌──────────────────────┐
                                                                            │  EXECUTOR REGISTRY   │
                                                                            │   (priority-sorted)  │
                                                                            └─────┬──────────┬─────┘
                                                                                  │          │
                                                              ┌───────────────────┘          └────────┐
                                                              ▼                                       ▼
                                                  ┌────────────────────┐                  ┌──────────────────┐
                                                  │  DeepAgentExecutor │                  │ FunctionExecutor │
                                                  │   A2AExecutor      │                  │  (alert/ceremony)│
                                                  │                    │                  │                  │
                                                  └─────────┬──────────┘                  └────────┬─────────┘
                                                            │ message.outbound.*                   │
                                                            │ linear.reply.{id}                    │
                                                            │ agent.skill.response.{cid}           │
                                                            ▼                                       │
                                                  ┌────────────────────┐                            │
                                                  │  PLATFORM SINKS    │  ◄─────────────────────────┘
                                                  │  Discord / GitHub  │
                                                  │  Linear / Google   │
                                                  └────────────────────┘
```

Everything else — telemetry, dashboard, HITL, fleet health — observes this spine from the side.

---

## Flow inventory

| # | Doc | Entry trigger | Terminal topic |
|---|---|---|---|
| 1 | [flow-inbound-message](flow-inbound-message.md) | `message.inbound.{platform}.*` | `message.outbound.{platform}.*` |
| 2 | [flow-linear-bridges](flow-linear-bridges.md) | `message.inbound.linear.issue.created` (`proto-task` label → `code.execute`@`proto`) | `linear.reply.{issueId}` |
| 3 | [flow-ceremonies](flow-ceremonies.md) | cron tick / external trigger | `ceremony.{id}.completed` + `autonomous.outcome.ceremony.{id}.{skill}` |
| 4 | [flow-pr-review](flow-pr-review.md) | `message.inbound.github.{owner}.{repo}.pull_request.{n}` | GitHub review (APPROVED / COMMENTED / CHANGES_REQUESTED) |
| 5 | [flow-alert-remediator](flow-alert-remediator.md) | fleet-health threshold trip → `action.*`; `feature.blocked` (from protoMaker) | `message.outbound.discord.alert` / Roxy `unblock_feature` / HITL |
| 6 | [flow-hitl](flow-hitl.md) | escalation site (stuck feature, exhausted remediation) | `operator.message.request` → Discord DM |
| 7 | [flow-agent-runtime-telemetry](flow-agent-runtime-telemetry.md) | executor lifecycle | `agent.runtime.activity.*`, `agent.skill.progress.*`, `agent.skill.latency`, `autonomous.outcome.*` |
| 8 | [flow-a2a-discovery](flow-a2a-discovery.md) | process startup | ExecutorRegistry enrollment |
| 9 | [flow-dashboard](flow-dashboard.md) | BusHistoryRecorder + API routes | dashboard tiles |
| 10 | [flow-a2a](flow-a2a.md) | `POST /a2a` (inbound) / `A2AExecutor` (outbound) / `POST /api/a2a/chat` | `agent.skill.response.{cid}` → A2A task events / poll / push callback |
| ✕ | [chokepoint-invariants](chokepoint-invariants.md) (cross-cut) | every `agent.skill.request` | drop + telemetry, or pass-through |

---

## How to read a flow doc

Every flow doc cites file:line for every topic and plugin claim. If something diverges from the doc, **the code is the source of truth** — file an issue (or fix the doc) rather than assuming the doc is right.

Mermaid sequence diagrams use these conventions:

- **Solid arrow** (`->>`) — synchronous bus publish
- **Dashed arrow** (`-->>`) — async response on a reply topic
- **Note over X** — a chokepoint check or persistence write
- **rect** block — a chokepoint or invariant region

---

## Discovering new flows

If you add a new trigger surface or a new self-contained sub-pipeline, add a doc here in the same shape. The index table is the single source of "flows we know about" — keeping it complete is what keeps this folder useful.

---
title: Flow — HITL escalation
---

_When an autonomous loop gets stuck, escalation sites publish `operator.message.request` which `OperatorRoutingPlugin` routes to a Discord DM. **Phase 1 outbound is shipped** (#619, #622); the operator-reply path back into the bus (Phase 2) is still open design — text commands vs. buttons vs. CLI/dashboard, decision pending real usage data._

---

## What & why

Bottlenecks are growth signals (see [memory: bottlenecks-are-growth](../../.claude/projects/-home-josh-dev-protoWorkstacean/memory/feedback_bottlenecks_are_growth.md)). A stuck autonomous loop should **escalate, not silently drop** — each escalation is a feature-request for the next layer of autonomy. HITL is the structural place to surface those.

Two production-wired escalation sources today, both pushing to the same `operator.message.request` topic:

| Source | What it escalates | Source | Shipped in |
|---|---|---|---|
| **pr-remediator** | Stuck PRs (budget exhausted, genuine semantic conflict, promotion-PR destructive-verdict guard) | `lib/plugins/pr-remediator.ts:_emitStuckHitlEscalation` | #619 |
| **dispatch-drop-escalator** | Drop storms (N drops on same key in M min — cooldown trips, target-unresolved, no-skill) | `src/plugins/dispatch-drop-escalator-plugin.ts` | #622 |
| **Operator routing** | Subscriber that takes any `operator.message.request` and routes to the admin Discord DM via `users.yaml` identity | `lib/plugins/operator-routing.ts:75–127` | pre-existing |

The previous `lib/plugins/hitl.ts` was ripped in commit `f658744` (2026-05-23) because it violated bus-is-the-contract — DiscordPlugin held a direct reference to `hitlPlugin.registerRenderer()`. The rip commit explicitly anticipated this reconnect: "If approval gates are needed later they'll be implemented as pure bus pub/sub with no registrar pattern." Phase 1 honors that — both #619 and #622 are pure publish-only.

---

## ASCII spine

```
   stuck PR (3 attempts)    drop storm (N drops in M min)    [future sources]
        │                          │                              │
        ▼                          ▼                              ▼
   ┌────────────┐         ┌────────────────────┐
   │ pr-        │         │ dispatch-drop-     │
   │ remediator │         │ escalator          │
   │            │         │                    │
   │ #619       │         │ #622               │
   └─────┬──────┘         └─────────┬──────────┘
         │                          │
         └──────────────┬───────────┘
                        ▼
   ┌──────────────────────────┐
   │  operator.message.       │  topic shape OperatorMessageRequest
   │  request                 │  { message, urgency, topic, from }
   └──────────────┬───────────┘
                  ▼
   ┌──────────────────────────┐
   │  OperatorRoutingPlugin   │  reads workspace/users.yaml
   │   resolves operator      │  routes to:
   │   userId                 │
   └──────────────┬───────────┘
                  ▼
   ┌──────────────────────────┐
   │  message.outbound.       │
   │  discord.dm.user.{userId}│
   └──────────────┬───────────┘
                  ▼
            Operator's Discord DM
                  │
                  ▼  (response path not implemented today)
            ⚠ no inbound subscriber for operator reply
```

---

## Sequence

```mermaid
sequenceDiagram
    autonumber
    participant Source as Escalation source<br/>(pr-remediator OR<br/>dispatch-drop-escalator)
    participant Bus as Bus
    participant OR as OperatorRoutingPlugin
    participant DP as DiscordPlugin
    participant OP as Operator

    Note over Source: stuck-loop signal detected
    Source->>Bus: operator.message.request<br/>{ message, urgency, topic, from }
    Source->>Source: console.warn (kept for log-tail visibility)
    Bus->>OR: deliver
    OR->>OR: lookup admin Discord ID<br/>via users.yaml
    OR->>Bus: message.outbound.discord.dm.user.{adminId}
    Bus->>DP: deliver
    DP->>OP: Discord DM
    Note over OP: Phase 2 reply path TBD — text commands<br/>vs. buttons vs. CLI/dashboard
```

---

## Bus topic table

| Topic | Publisher(s) | Subscriber | Status |
|---|---|---|---|
| `operator.message.request` | pr-remediator (#619), dispatch-drop-escalator (#622) | OperatorRoutingPlugin | ✅ wired |
| `operator.message.failed.{correlationId}` | OperatorRoutingPlugin (when no transport available) | _(no subscriber yet — for future HTTP callers)_ | ✅ wired publisher side |
| `message.outbound.discord.dm.user.{userId}` | OperatorRoutingPlugin | DiscordPlugin DM sink | ✅ wired |
| `operator.message.response` | _Phase 2 — not yet implemented_ | _Phase 2 — pr-remediator would consume_ | ❌ aspirational |

---

## Escalation trigger sites (today)

All sites publish `operator.message.request` AND keep their `console.warn` (log-tail visibility is independent of the bus path).

### pr-remediator ([pr-remediator.ts](../../lib/plugins/pr-remediator.ts), all flow through `_emitStuckHitlEscalation`):

| Site | Condition | Urgency |
|---|---|---|
| Budget exhaustion (line 770, 744) | `attempts ≥ MAX_ATTEMPTS_PER_PR (3)` | `normal` |
| diagnose verdict "genuine" (line 1598) | LLM judges semantic conflict | `high` |
| diagnose verdict "decomposable" on promotion PR (line 1536) | #465 destructive verdict guard | `high` |

### dispatch-drop-escalator ([dispatch-drop-escalator-plugin.ts](../../src/plugins/dispatch-drop-escalator-plugin.ts)):

| Drop reason | Threshold | Urgency |
|---|---|---|
| `cooldown` | 10 drops on same key in 10min | `normal` |
| `target_unresolved` | same | `high` |
| `no_skill` | same | `high` |

All thresholds + windows + cooldowns env-tunable. Per-key escalation cooldown (default 30min) prevents DM spam.

---

## Operator-routing details

[operator-routing.ts](../../lib/plugins/operator-routing.ts):

```
on operator.message.request:
    payload: { message, urgency, topic, from }
    look up operator userId from workspace/users.yaml
    publish message.outbound.discord.dm.user.{userId}
        with payload.content = formatted message
```

[`workspace/users.yaml`](../../workspace/users.yaml) — operator list with Discord user IDs. The plugin reads this at install and routes by `urgency` field (could escalate to multiple operators in future; today it picks the first).

---

## Phase 2 — operator reply UX (open design)

The outbound path is shipped. The inbound path — operator's Discord DM reply re-entering the bus as a structured `operator.message.response` — is undecided. Three viable shapes:

1. **Text commands** in DM (`pr-remediator: merge #123`) → parsed by DiscordPlugin DM handler, published as `operator.message.response`. Pure bus, no Discord UI dependencies.
2. **Discord buttons / interaction handlers** — richer UX, but the old HITL plugin used a registrar pattern for buttons that was the explicit reason for the f658744 rip. Reintroducing buttons requires designing a bus-pure rendering protocol.
3. **CLI / dashboard action** — separate surface entirely; operator runs `wsk operator reply <correlationId> <decision>` or clicks in the dashboard.

Decision deferred until ~1 week of Phase 1 escalation data informs which shape fits real usage patterns.

---

## Failure modes & gotchas

- **Promotion-PR destructive guard now escalates loudly** (`#465`) — the LLM-decomposable verdict on a release PR suppresses the close AND fires an operator DM at `urgency: high` (since Phase 1 shipped in #619). Previously this was the most-visible "wire-incomplete" surface; now it's the most-visible "wired" surface.
- **Live CI re-check before escalating `fix_ci`** (line 821–830) — prevents spurious "stuck on CI" escalation if CI flipped green. Good. But also masks the case where CI flipped green *because* something else fixed it, not because the original issue was resolved.
- **`InFlightEntry.escalated` is a one-shot flag** ([line 196](../../lib/plugins/pr-remediator.ts)) — once set, no further escalations on the same PR. If a real new failure mode appears, it's not re-escalated. Acceptable today (we don't have multiple operators); revisit if HITL becomes a queue.
- **`operator.message.request` is fire-and-forget** ([line 76](../../lib/plugins/operator-routing.ts)) — no acknowledgment topic. If the DM send fails, the publisher doesn't know. The OperatorRoutingPlugin logs failures but doesn't notify upstream.

---

## Related

- [chokepoint-invariants](chokepoint-invariants.md) — #465 is the most well-formed HITL escalation site
- [flow-alert-remediator](flow-alert-remediator.md) — pr-remediator hosts most escalation sites
- [flow-dashboard](flow-dashboard.md) — once escalations are bussed, the dashboard can count them
- [memory: bottlenecks-are-growth](../../.claude/projects/-home-josh-dev-protoWorkstacean/memory/feedback_bottlenecks_are_growth.md) — the design principle behind this flow

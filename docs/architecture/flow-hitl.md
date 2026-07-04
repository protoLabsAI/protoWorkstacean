---
title: Flow — HITL escalation
---

_When an autonomous loop gets stuck, escalation sites publish `operator.message.request` which `OperatorRoutingPlugin` routes to a Discord DM. **Phase 1 outbound is shipped** (#622); the operator-reply path back into the bus (Phase 2) is still open design — text commands vs. buttons vs. CLI/dashboard, decision pending real usage data._

---

## What & why

Bottlenecks are growth signals. A stuck autonomous loop should **escalate, not silently drop** — each escalation is a feature-request for the next layer of autonomy. HITL is the structural place to surface those.

One production-wired escalation source today, plus the routing subscriber, both over the `operator.message.request` topic:

| Source | What it escalates | Source | Shipped in |
|---|---|---|---|
| **dispatch-drop-escalator** | Drop storms (N drops on same key in M min — cooldown trips, target-unresolved, no-skill) | `src/plugins/dispatch-drop-escalator-plugin.ts` | #622 |
| **Operator routing** | Subscriber that takes any `operator.message.request` and routes to the admin Discord DM via `users.yaml` identity | `lib/plugins/operator-routing.ts` | pre-existing |

The previous `lib/plugins/hitl.ts` was ripped in commit `f658744` (2026-05-23) because it violated bus-is-the-contract — DiscordPlugin held a direct reference to `hitlPlugin.registerRenderer()`. The rip commit explicitly anticipated this reconnect: "If approval gates are needed later they'll be implemented as pure bus pub/sub with no registrar pattern." Phase 1 honors that — dispatch-drop-escalator is pure publish-only.

---

## ASCII spine

```
   drop storm (N drops in M min)      [future sources]
        │                                  │
        ▼                                  ▼
   ┌────────────────────┐
   │ dispatch-drop-     │
   │ escalator          │
   │                    │
   │ #622               │
   └─────────┬──────────┘
             │
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
    participant Source as Escalation source<br/>(dispatch-drop-escalator)
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
| `operator.message.request` | dispatch-drop-escalator (#622) | OperatorRoutingPlugin | ✅ wired |
| `operator.message.failed.{correlationId}` | OperatorRoutingPlugin (when no transport available) | _(no subscriber yet — for future HTTP callers)_ | ✅ wired publisher side |
| `message.outbound.discord.dm.user.{userId}` | OperatorRoutingPlugin | DiscordPlugin DM sink | ✅ wired |
| `operator.message.response` | _Phase 2 — not yet implemented_ | _Phase 2 — an escalation source would consume_ | ❌ aspirational |

---

## Escalation trigger sites (today)

All sites publish `operator.message.request` AND keep their `console.warn` (log-tail visibility is independent of the bus path).

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
on operator.message.request (payload.type === "operator_message_request"):
    payload: { message, urgency, topic, from, correlationId }
    look up the first admin Discord ID via IdentityRegistry (workspace/users.yaml)
    if found:
        publish message.outbound.discord.dm.user.{userId}
            with payload.content = urgency badge + [topic] prefix + message + "— {from}" attribution
    else:
        throw OperatorUnreachableError → caught in install(), published as
        operator.message.failed.{correlationId} (no silent drop)
```

`IdentityRegistry` is the single source of truth for operator identity, backed by [`workspace/users.yaml`](../../workspace/users.yaml). The first admin user with a Discord identity is the DM recipient; there is no env-var fallback. Multi-channel / presence-based routing is a designed-for branch, not yet implemented — today it's a single Discord DM.

---

## Phase 2 — operator reply UX (open design)

The outbound path is shipped. The inbound path — operator's Discord DM reply re-entering the bus as a structured `operator.message.response` — is undecided. Three viable shapes:

1. **Text commands** in DM (`dispatch-drop: mute cooldown 30m`) → parsed by DiscordPlugin DM handler, published as `operator.message.response`. Pure bus, no Discord UI dependencies.
2. **Discord buttons / interaction handlers** — richer UX, but the old HITL plugin used a registrar pattern for buttons that was the explicit reason for the f658744 rip. Reintroducing buttons requires designing a bus-pure rendering protocol.
3. **CLI / dashboard action** — separate surface entirely; operator runs `wsk operator reply <correlationId> <decision>` or clicks in the dashboard.

Decision deferred until ~1 week of Phase 1 escalation data informs which shape fits real usage patterns.

---

## Failure modes & gotchas

- **`operator.message.request` failure is observable but async** — if no admin Discord identity is configured, `_route()` throws `OperatorUnreachableError`, which `install()` catches and republishes as `operator.message.failed.{correlationId}`. Bus subscribers (like dispatch-drop-escalator) don't subscribe to that failure topic — only synchronous HTTP callers do — so an escalation that fails to deliver is logged at `console.error` but not retried.
- **Per-key escalation state is in-memory** — a workstacean restart resets the drop-storm counters and per-key escalation cooldowns, so a storm that spanned a restart starts counting fresh. Intentional, but means escalation state is not durable.

---

## Related

- [chokepoint-invariants](chokepoint-invariants.md) — the dispatcher-invariant pattern (and the retired #465 destructive-verdict guard)
- [flow-alert-remediator](flow-alert-remediator.md) — the fleet-alerts path
- [flow-dashboard](flow-dashboard.md) — once escalations are bussed, the dashboard can count them
- **Bottlenecks are growth** — the design principle behind this flow: every escalation is a feature-request for the next layer of autonomy

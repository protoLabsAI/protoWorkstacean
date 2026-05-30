---
title: Flow — Inbound Message
---

_The central spine: a message arrives from a platform, the router resolves a skill, the dispatcher runs it, the executor produces a reply, the platform plugin posts it back. Every other flow either feeds this one or observes it._

---

## What & why

Discord/GitHub/Linear/Google webhooks land as `message.inbound.*` topics. [RouterPlugin](../../src/router/router-plugin.ts) deterministically resolves keyword + channel → skill and re-publishes as `agent.skill.request`. [SkillDispatcherPlugin](../../src/executor/skill-dispatcher-plugin.ts) is the **sole subscriber** to that topic and the system's main chokepoint: it enforces cooldown, resolves an executor, runs it, and publishes outcome telemetry. Reply text routes back to the originating platform via `message.outbound.{platform}.*`.

No LLM in the routing layer. Routing is keyword/channel YAML; LLM-driven decisions happen *inside* executors.

**Linear inbound is a special case.** RouterPlugin dispatches a Linear event **only via an explicit `skillHint`** — Linear content is never keyword-matched. `LinearPlugin` stamps `skillHint: linear_agent_respond` on @mention notifications (`issueMention`/`issueCommentMention`) and on agent-session events for issues **assigned to Ava** (`isAssignedToAva`, fail-open). Everything else on Linear is un-hinted and dropped. So Ava responds on Linear only when @mentioned or assigned. The `proto-task` label path is handled separately by `linear-proto-bridge` (see [flow-linear-bridges](flow-linear-bridges.md)).

---

## ASCII spine

```
   Discord/GitHub/Linear/Google
              │
              ▼
   ┌──────────────────────────┐
   │ message.inbound.{plat}.* │  ← published by trigger plugin
   └──────────────┬───────────┘
                  │
                  ▼
        ┌─────────────────┐
        │ RouterPlugin    │       channels.yaml + keyword tables
        │   resolve skill │       (no LLM)
        └────────┬────────┘
                 │
                 ▼
   ┌──────────────────────────┐
   │  agent.skill.request     │  payload: { skill, content, targets?, reply.topic, meta }
   └──────────────┬───────────┘
                  │  (sole subscriber)
                  ▼
   ┌──────────────────────────┐
   │  SkillDispatcherPlugin   │  CHOKEPOINT
   │  ─────────────────────   │  1. mark activeExecutions
   │  cooldown check          │  2. ExecutorRegistry.resolve(skill, targets)
   │  resolve executor        │  3. publish flow.item.created
   │  await executor.execute  │  4. await (no timeout)
   │  publish outcome         │  5. publish autonomous.outcome + flow.item.completed
   └──────────────┬───────────┘
                  │
        ┌─────────┼─────────┐
        ▼         ▼         ▼
    DeepAgent    A2A    FunctionExecutor
    Executor     Exec   (alert/ceremony/pr-r)
        │         │         │
        └─────────┴─────────┘
                  │
                  ▼
   ┌──────────────────────────┐
   │  message.outbound.{plat} │  or `linear.reply.{issueId}`
   │      .{channel}          │  or `agent.skill.response.{correlationId}`
   └──────────────┬───────────┘
                  │  (platform plugin subscribes)
                  ▼
              External API
        (Discord / GitHub / Linear)
```

---

## Sequence (Discord chat path — representative)

```mermaid
sequenceDiagram
    autonumber
    participant Ext as Discord (external)
    participant DP as DiscordPlugin
    participant Bus as Bus
    participant R as RouterPlugin
    participant SD as SkillDispatcher
    participant ER as ExecutorRegistry
    participant E as Executor

    Ext->>DP: MessageCreate event
    DP->>Bus: message.inbound.discord.{channelId}
    Bus->>R: deliver
    R->>R: resolve skill (channels.yaml + keywords)
    R->>Bus: agent.skill.request<br/>(reply.topic = message.outbound.discord.{ch})
    Bus->>SD: deliver

    rect rgb(240, 230, 220)
        Note over SD: CHOKEPOINT
        SD->>SD: mark activeExecutions
        SD->>SD: cooldown check (#437)
        SD->>ER: resolve(skill, targets)
        ER-->>SD: executor | null
        SD->>Bus: flow.item.created
    end

    SD->>E: execute(req)
    E-->>SD: { text, error?, taskState }

    alt taskState ∈ {submitted, working}
        SD->>SD: hand off to TaskTracker<br/>(returns early; outcome published later)
    else terminal
        SD->>Bus: agent.skill.response.{correlationId}<br/>(or req.reply.topic)
        SD->>Bus: message.outbound.discord.{ch}
        SD->>Bus: autonomous.outcome.{systemActor}.{skill}
        SD->>Bus: flow.item.completed
    end

    Bus->>DP: deliver outbound
    DP->>Ext: discord.js send()
```

---

## Bus topic table

| Topic | Published by | Subscribed by | File:line |
|---|---|---|---|
| `message.inbound.discord.{channelId}` | DiscordPlugin | RouterPlugin | `lib/plugins/discord/inbound.ts:130,247,283` |
| `message.inbound.github.{owner}.{repo}.{event}.{n}` | GitHubPlugin | RouterPlugin, PR-review handler | `lib/plugins/github.ts:635,700,795,939` |
| `message.inbound.linear.{event}` | LinearPlugin | RouterPlugin (skillHint-only), linear-proto-bridge | `lib/plugins/linear.ts` |
| `agent.skill.request` | RouterPlugin, linear-proto-bridge, SkillDispatcher (mailbox drain) | **SkillDispatcherPlugin (sole)** | `src/router/router-plugin.ts:272,322`; `src/executor/skill-dispatcher-plugin.ts:507` |
| `flow.item.created` | SkillDispatcher | telemetry / dashboard | `src/executor/skill-dispatcher-plugin.ts:275` |
| `flow.item.updated` | SkillDispatcher (running / error) | telemetry / dashboard | `src/executor/skill-dispatcher-plugin.ts:370,385,457` |
| `agent.skill.progress.{correlationId}` | executor (opt-in) | dashboard / streaming | `src/event-bus/payloads.ts:86-95` |
| `agent.skill.response.{correlationId}` *(default reply)* | SkillDispatcher | platform plugins via correlationId match | `src/executor/skill-dispatcher-plugin.ts:644,649` |
| `message.outbound.discord.{channelId}` | SkillDispatcher / executor | DiscordPlugin outbound | `lib/plugins/discord/outbound.ts:43,129` |
| `message.outbound.github.{owner}.{repo}.{n}` | SkillDispatcher / executor | GitHubPlugin | `lib/plugins/github.ts:298,375` |
| `linear.reply.{issueId}` | SkillDispatcher / executor | LinearPlugin | `lib/plugins/linear.ts:561,565` |
| `autonomous.outcome.{systemActor}.{skill}` | SkillDispatcher | AgentFleetHealth | `src/executor/skill-dispatcher-plugin.ts:538` |
| `flow.item.completed` | SkillDispatcher | telemetry / dashboard | `src/executor/skill-dispatcher-plugin.ts:418` |

---

## Chokepoint details

The dispatcher enforces invariants in this order ([skill-dispatcher-plugin.ts:166–480](../../src/executor/skill-dispatcher-plugin.ts)):

1. **activeExecutions** set **before any `await`** — line 189. Blocks concurrent DM turn queuing.
2. **Skill presence** — drops if missing (line 191–196).
3. **Executor resolution** via `ExecutorRegistry.resolve(skill, targets)` — drops if null (line 198–208). This is the de-facto target-registry guard ([chokepoint-invariants.md](chokepoint-invariants.md)).
4. **Cooldown** — per-skill-per-repo key, default 30s for `bug_triage`/`pr_review`, 60s for `security_triage`, env-override `WORKSTACEAN_COOLDOWN_MS_<SKILL>` (line 216–230). Drops with `console.warn`, no bus event.
5. **`flow.item.created`** publish (line 275) — telemetry side-effect, not gating.
6. **`await executor.execute(req)`** — **no timeout wrapper**. A2A executors can hang indefinitely; see Failure modes.
7. **TaskTracker hand-off** if `taskState ∈ {submitted, working}` (line 291–379) — long-running A2A; dispatcher returns early.
8. **Outcome publish** on terminal (line 418, 538) — both `flow.item.completed` and `autonomous.outcome.*`.
9. **`finally`** drains ContextMailbox (line 478).

---

## Failure modes & gotchas

- **No execute() timeout** — `await executor.execute()` at line 286 is unguarded. A2A hangs leave the dispatcher slot occupied indefinitely. Mitigation lives inside individual executors (A2A SDK has its own timeouts).
- **Cooldown drops emit `dispatch.dropped.cooldown`** (since #620) — dashboard tiles + `dispatch-drop-escalator` (#622) consume this. Reply topic also gets an error response. Console.warn preserved for log-tail visibility.
- **Synthetic actors pollute fleet metrics if unfiltered** — `systemActor` whitelisting happens at [AgentFleetHealthPlugin._record](../../src/plugins/agent-fleet-health-plugin.ts) (line 281–334), **not** at the dispatcher. See [chokepoint-invariants.md](chokepoint-invariants.md).
- **Self-cascade guard on GitHub events** — DiscordPlugin/GitHubPlugin filter bot-authored events (`protoquinn[bot]`, `ava[bot]`, `protobot[bot]`) at webhook time to prevent infinite Quinn → issue → webhook → Quinn loops ([github.ts:524–542](../../lib/plugins/github.ts)). PR events are intentionally NOT filtered — Quinn-authored PRs still get reviewed.
- **`bug_triage` success has a deferred side-effect** — async board filing if `projectPath` is set (line 332–334). Doesn't block the response; failures here are invisible to the requester.
- **`correlationId` is the only reply linkage** — if the correlationId is dropped between inbound and outbound, the reply lands but is orphaned (no thread, no parent). Trigger plugins must preserve it on `msg.reply?.topic`.

---

## Related flows

- [flow-linear-bridges](flow-linear-bridges.md) — the `proto-task` label bridge builds its own `agent.skill.request` instead of routing through RouterPlugin.
- [flow-pr-review](flow-pr-review.md) — GitHub PR events follow this flow but with a fixed `skillHint=pr_review`.
- [chokepoint-invariants](chokepoint-invariants.md) — the four invariants that sit inside the dispatcher.
- [flow-agent-runtime-telemetry](flow-agent-runtime-telemetry.md) — what the dispatcher's outcome topics feed.

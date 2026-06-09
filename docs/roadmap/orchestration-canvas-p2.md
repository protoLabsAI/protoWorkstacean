# Orchestration Canvas — P2: Wiring Authoring

> Phase 2 of [ADR-0008](../decisions/0008-visual-orchestration-surface-for-the-fleet). P1 (the live canvas — palette · graph · executions · trace) is complete. P2 turns the read-only canvas into a **wiring authoring** surface: draw an edge "when X fires, agent B reacts" and the registrar writes **declarative config** — never code, never a data-flow graph.

## The line P2 proves

ADR-0008 **D5**: *"Drawing an edge 'when A emits X, B reacts' writes a subscription/route through the registrar. Never code, never data-flow. Multi-step logic is a declarative workflow (D6, P3), rendered read-only."*

Today the fleet's wiring is **implicit** and spread across three places:
- `workspace/channels.yaml` — `(platform, channelId) → agent`
- agent YAML `skills[].keywords` — keyword → skill (the `SkillResolver`)
- A2A agent YAML `subscribesTo` — topic patterns an A2A agent listens to

None of it is operator-authorable from the canvas, and none expresses the general case: **"when this bus topic fires, dispatch this skill to this agent."** P2 makes that explicit and authorable as a new declarative layer — `routes.d/` — without touching the implicit paths (they keep working).

This is **choreography**, not a workflow engine: a route is one pub/sub hop (topic → `agent.skill.request`). Multi-step lives in P3's rendered workflows.

## The new primitive: a route

`workspace/routes.d/<name>.yaml` — one file per route, hot-reloaded like `agents.d/`:

```yaml
name: triage-on-new-issue
description: New GitHub issues on any repo go to Quinn for triage.
when:
  topic: message.inbound.github.#   # AMQP-style pattern, same matcher as the bus
then:
  skill: bug_triage
  agent: quinn                      # optional explicit target; omit → skill-resolved
enabled: true
```

- **`when.topic`** — a bus topic pattern (the existing `#`/`*` matcher). The authorable trigger.
- **`then`** — `{ skill, agent? }`. The reaction: publish `agent.skill.request` with that skill + target.
- **`enabled`** — absence = enabled (greenfield: no flag-soup; an off route is a deleted route, but `enabled:false` lets the canvas grey it without deleting).

A route is **wiring only**. It carries no payload transform, no `output→input`, no conditionals — that boundary is the whole point (D1/D5). Payload passes through untouched; the *agent* decides what to do.

## Architecture (mirrors the registrar pattern)

```
canvas draw-edge ─▶ POST /api/routes ─▶ command.route.upsert ─▶ ControlPlaneRegistrar
                                                                   └▶ writes routes.d/<name>.yaml
                                                                          │ (hot-reload ~5s)
RoutesPlugin: load routes.d/ ─▶ subscribe(when.topic) ─▶ on match ─▶ publish agent.skill.request(then)
                                                                          │
SkillDispatcher (unchanged chokepoint) ─▶ executor ─▶ agent
```

- **`RoutesPlugin`** (new) — loads `routes.d/`, subscribes to each route's `when.topic`, and on a match publishes `agent.skill.request` with `{ skill, targets:[agent] , correlationId }`. Hot-reloads on file change; `uninstall()` unsubscribes. It is a *pure bus participant* — no plugin references (the contract).
- **`ControlPlaneRegistrar`** — gains `command.route.upsert`/`command.route.remove` → write/delete `routes.d/<name>.yaml`. Sole writer (the registrar exemption).
- **`routes-crud.ts` API** — `GET /api/routes` (list live routes, for the canvas to render as edges), `POST /api/routes` (validate + publish `command.route.upsert`, admin-keyed), `DELETE /api/routes/:name`. Mirrors `agents-crud.ts`.
- **Dispatcher unchanged** — routes funnel into the same `agent.skill.request` chokepoint, so every invariant (cooldown, target-registry guard, synthetic-actor filter, destructive-verdict guard) still applies. No new dispatch path.

## Slices (each its own PR, P1 cadence)

- **P2-a — backend route layer + authoring API.** `routes.d/` schema + pure loader/validator; `RoutesPlugin` (load · subscribe · dispatch · hot-reload · uninstall); registrar `command.route.*`; `routes-crud` API (GET/POST/DELETE); wire into `src/index.ts`; dashboard api helpers. Unit-tested end to end against the in-memory bus (no mocks).
- **P2-b — frontend wiring authoring.** Render live routes as canvas edges (trigger-topic → agent) on `/system` (or a dedicated wiring layer); **draw an edge** node→node → a route form (pick trigger topic + skill) → `POST /api/routes`; delete-edge → `DELETE`. The route appears live within the hot-reload window.

## Guardrails (what P2 must NOT become)

- ❌ No payload transform / templating on a route — that's data-flow logic. (Templating exists only inside P3's declarative workflows.)
- ❌ No conditionals / branching on a route edge — a route is one unconditional hop.
- ❌ No new dispatch path — routes publish `agent.skill.request`; the dispatcher stays the sole chokepoint.
- ❌ Don't replace the implicit paths (channels.yaml, keyword routing) — `routes.d/` is additive.

## Acceptance

Drawing an edge from a trigger to an agent on the canvas creates a `routes.d/` file via the control-plane write API; within the hot-reload window a message on that topic dispatches the chosen skill to that agent, visible as a live dispatch animation (P1 WS-3b) and a row in Executions.

## Open questions (resolve in P2-a)

- **Trigger vocabulary** — start with `when.topic` (most general, bus-native). Keyword/channel triggers are already served by `SkillResolver`/`channels.yaml`; only add them to `routes.d/` if authoring them from the canvas proves worth the overlap.
- **Self-trigger / cascade guards** — a route whose `then` re-emits its own `when` topic would loop. Reuse the dispatcher's cooldown + the self-cascade guard; a route loader sanity-check (then-topic ≠ when-pattern) is cheap insurance.

## Related

- [ADR-0008](../decisions/0008-visual-orchestration-surface-for-the-fleet) — D5 (wiring authoring), the doctrine.
- [orchestration-canvas-p1](./orchestration-canvas-p1) — the live canvas P2 builds on.
- `src/router/` (`SkillResolver`), `src/plugins/control-plane-registrar-plugin.ts` (the registrar pattern), `src/api/agents-crud.ts` (the write-API pattern P2's API mirrors).

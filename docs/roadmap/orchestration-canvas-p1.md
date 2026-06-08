---
title: "Orchestration Canvas — P1 Implementation Plan"
---

# Orchestration Canvas — P1 Implementation Plan

> **P1 of [ADR-0008](../decisions/0008-visual-orchestration-surface-for-the-fleet).** Turn the read-only `dashboard/` into the **live orchestration canvas** — one command hub's view of every agent it commands (built-in + distributed A2A), with live dispatch flowing through the graph. P1 is the keystone: it proves the whole thesis with no exotic infra. *Observability + palette only; wiring authoring is P2, workflows are P3, and there is never `node.output→node.input` logic authoring.*

## Why P1 is small (the assets already exist)

| Need | Already have | Gap |
|---|---|---|
| Node-graph canvas | `dashboard/src/components/SystemGraph.tsx` — live `@xyflow/react` (ReactFlow) topology, edges animate on bus traffic | Make it the *primary stage*; tier-tag nodes; show execution, not just topology |
| Brand / design system | `dashboard/` already deps `@protolabsai/design` + `@protolabsai/ui` (public npm v0.3.0); tokens adopted in PR #701 | Adopt `@protolabsai/ui` primitives; apply the protoAgent **layout** over them |
| Palette data | `GET /api/control-plane/state` (agents + mcp), `/api/agents/runtime`, the live `ExecutorRegistry` | Render it as a browsable, tier-tagged palette |
| Live execution model | `flow.item.{created,updated,completed}` on the bus + `BusHistoryRecorder` (in-memory ring) | **Persist** it (durable history + replay) |
| Node inspector | `MessageDrawer.tsx`, `SkillTrace.tsx` | Wire into the right panel of the new shell |

So P1 = a **layout port + one new durable store + re-skinning**, not a green-field build.

## Design foundation (decided)

- **Layout = protoAgent `apps/web` app-shell.** 3-row grid (topbar 48px / workspace / utility-bar 28px); workspace = **72px icon rail · center stage · resizable+collapsible right panel** (localStorage-persisted); **state-driven swappable surfaces** (no router churn); **SSE-live** updates. Dense, dark, technical.
- **Brand = `@protolabsai/design` tokens + `@protolabsai/ui` components** — *not* protoAgent's own `theme.css`. One canonical identity: lavender `#9b87f2` (brand moments only, never button fills), ground `#0a0a0c`, Geist/Geist Mono, OKLCH status, 4px radius/grid, dark-first. "Grayer and smaller; everything functional."
- **Canvas tech = the existing ReactFlow `SystemGraph`** + persisted `flow.item.*`.

### Surface map (the rail)

| Rail surface | Built from | Shows |
|---|---|---|
| **Canvas** (primary) | `SystemGraph` (ReactFlow) | Live node graph: agents tier-tagged `builtin` / `a2a`; edges animate on dispatch; click a node → inspector |
| **Executions** | persisted `flow.item.*` + `SkillTrace` | Live execution thread (history + replay); per-correlationId trace |
| **Palette** | `/api/control-plane/state` + `Console`/`McpPanel` | Browsable agents / MCP tools / protoAgent node-packs; drag-to-add via the existing control-plane write API |
| **System** | `AgentsView`, `LatencyHistogram`, `QuinnVerdictCounters`, settings | Runtime roster, telemetry, fleet health |

Right panel = **node inspector / message drawer** (`MessageDrawer`), resizable + collapsible.

## Workstreams (sequenced — each shippable)

### WS-1 — Durable `flow.item` store (backend, foundation)
The only genuinely new backend. Everything visual depends on it for history/replay.
- New store `src/knowledge/flow-store.ts` (bun:sqlite, `${dataDir}/flow.db` *or* a table in `knowledge.db`), mirroring the `RegistrationStore`/`push-notification-store` pattern (pure-core + injectable path, fail-soft).
- Subscribe to `flow.item.{created,updated,completed}`; upsert by `id`; capture `type/status/stage/timestamps/meta(skill,executorType,targetAgent,…)/correlationId/parentId`.
- **Retention is mandatory** — heed the events.db lesson ([[gotcha_sqlite_auto_vacuum_existing_db]]): bounded rows + `auto_vacuum=INCREMENTAL`; a sweep + cap. Sample/aggregate high-volume runs.
- Query API: `GET /api/flows?since=…&limit=…&status=…`, `GET /api/flows/:correlationId` (the execution graph for one trace). Pure aggregation unit-tested off synthetic events (like `quinn-review-eval`).
- *Acceptance:* restart-survivable; a historical flow renders after a redeploy.

### WS-2 — App-shell port (frontend)
Replace `dashboard/src/Layout.tsx` (NavLink sidebar + `Outlet`) with the protoAgent shell.
- New `Shell.tsx`: the 3-row grid (topbar / workspace / utility-bar); 72px **icon rail** (lucide) for the four surfaces; **resizable+collapsible right panel** (drag handle, localStorage width/collapsed); **state-driven surface switch** (keep `react-router` for deep-links, but render surfaces as components).
- Built on **`@protolabsai/ui`** primitives (Button, Badge, Card, Stat, Row) over `@protolabsai/design` tokens — delete ad-hoc styles where a primitive exists. Keep `Layout.css` only for shell-grid specifics, all colors via `--pl-*`.
- *Acceptance:* the five existing panes render inside the new shell; visual parity with protoAgent's density on the official brand.

### WS-3 — Canvas surface (the keystone view)
Promote `SystemGraph` to the primary stage and make it *execution-aware*.
- **Tier-tag nodes** `builtin` vs `a2a` (from `/api/agents/runtime` + `ExecutorRegistry`); distinct node styles; A2A nodes show their host (roxy@steamdeck).
- **Live dispatch animation** drawn from `flow.item.*` (live via the existing WS `/api/bus/subscribe`), not just topology edges — a dispatch *to a distributed A2A agent* animates the same as an in-process one (it all flows through the hub).
- Click node → **right-panel inspector** (recent skills, tool-calls, last flow item, jump to `SkillTrace`).
- *Acceptance — the demo:* a real dispatch to an in-process agent **and** one out to a distributed A2A agent (roxy@steamdeck) both animate live on one canvas, drawn from the one bus.

### WS-4 — Palette surface
- Render the live `ExecutorRegistry` (`/api/control-plane/state`) as a tier-tagged, searchable palette (agents · MCP tools · protoAgent node-packs).
- **Add-a-node** reuses the shipped control-plane write API (`/api/agents`, `/api/a2a-endpoints`, `/api/mcp-servers`) + `Console`/`McpPanel` forms — drag-to-add is UX over existing endpoints. **No new mutation path.**
- *Acceptance:* registering an A2A agent from the palette makes it appear as a canvas node within the hot-reload window.

## Out of scope for P1 (guardrails)

- ❌ Wiring authoring (draw "who reacts to what") → **P2**.
- ❌ Rendered declarative workflows (`WorkflowExecutor` over protoAgent's YAML DAG) → **P3**.
- ❌ Any `node.output→node.input` data-flow logic authoring → **never** (ADR-0008 D1 / ADR-0004 §8).
- ❌ Multi-hub / peer-workstacean federation → out of scope entirely (one command hub).
- Keep the dashboard's read-only-by-default + admin-keyed-write split (ADR-0004 §4.4); the palette's writes go through the already-auth-gated control-plane API.

## Open implementation questions

- **`flow.item` store home & retention window** — `flow.db` vs a `knowledge.db` table; how long to keep, and sampling under burst (the canvas must stay real-time).
- **Live transport for the canvas** — reuse the existing WS `/api/bus/subscribe` (dashboard already does) vs SSE (protoAgent's pattern). Lean: keep the WS the dashboard already has.
- **How much of protoAgent's shell to copy vs rebuild** — port the grid/rail/right-panel structure; rebuild the surfaces on `@protolabsai/ui` rather than copying protoAgent's `theme.css`-coupled components.
- **Node identity on the canvas** — key by agent name; A2A nodes carry host metadata; collisions don't happen (one hub).

## Suggested build order

**WS-1 (durable flow store) → WS-2 (shell) → WS-3 (canvas, the demo) → WS-4 (palette).** WS-1 is backend + fully unit-testable (safe first slice); WS-3 is the keystone to *show*. Each lands as its own PR.

## Related
- [ADR-0008](../decisions/0008-visual-orchestration-surface-for-the-fleet) — the doctrine this implements.
- [ADR-0004](../decisions/0004-fleet-control-plane-and-hot-swappable-extension) — registries, control-plane API, `SystemGraph`, the read/write split.
- [ADR-0007](../decisions/0007-workstacean-as-fleet-a2a-gateway) — how distributed A2A agents are commanded (the nodes the canvas shows).
- `dashboard/` — the surface being evolved (`SystemGraph`, `MessageDrawer`, `SkillTrace`, `Console`, `McpPanel`).
- protoAgent `apps/web` — the layout-shell template; protoContent `@protolabsai/design` + `@protolabsai/ui` — the brand.

---
title: "ADR-0004: Fleet Control Plane & Hot-Swappable Extension"
---

# ADR-0004: Fleet Control Plane & Hot-Swappable Extension

- **Status:** Accepted — 2026-06-01
- **Deciders:** Josh (operator)
- **Related:** [ADR-0001](./0001-org-to-execution-pipeline), [ADR-0002](./0002-workstacean-protomaker-integration-boundary); protoAgent ADR 0001 (Extensibility & Plugin Architecture), ADR 0002 (Reusable Subagent Workflows), ADR 0005 (Tool Pollution & Progressive Disclosure); ORBIS `config/delegates.yaml` + `/api/delegates`
- **Tags:** architecture, agent, plugins, registry, control-plane, observability, hot-reload

> We want to extend and modify the fleet — add agents, wire in capabilities, change rituals — **without rebuilding the image or restarting the container**, and to **see what the system is doing without tailing logs**. Today most of that forces a restart, and the one extension surface meant for it (workspace TS plugins) is structurally broken. This ADR decides how protoWorkstacean becomes pluggable and observable: a **fleet control plane** built from hot-reloadable, file-backed registries with a write API + a dedicated management surface, where the units of extension are **external agents (A2A), MCP servers, and declarative rituals — never hot-loaded in-process code** — and where live state is durable and exposed through one read surface. It honors the load-bearing decisions already made (bus-is-the-contract, the read-only debug dashboard, no world-model, federate-don't-replace-the-bus).

---

## 1. Context & Problem

protoWorkstacean is the switchboard: `trigger → router → dispatcher → executor` over a typed bus. Extending it today is uneven. Some surfaces hot-reload; the ones that matter most for "add a new agent" do not, and the dynamic-code surface is broken.

**What hot-reloads vs. what forces a restart (audited 2026-06-01):**

| Surface | Add / modify cost today |
|---|---|
| Ceremonies (`workspace/ceremonies/*.yaml`) | ✅ hot-reload (5 s watch) + CRUD API |
| Channels (`workspace/channels.yaml`) | ✅ hot-reload (5 s watch) |
| Crons (SchedulerPlugin) | ⚠️ runtime add/remove via bus command; no file-watch |
| A2A agent **skills** (remote card change) | ✅ auto re-register (`ExecutorRegistry.unregister()` already exists) |
| **DeepAgents (`workspace/agents/*.yaml`)** | ~~❌ boot-only → restart~~ → ✅ **hot-reload (P1 shipped, #714/#715)** |
| **A2A agent entries (`workspace/agents.yaml`)** | ❌ **boot-only load → restart** |
| **Workspace plugins (`workspace/plugins/*.ts`)** | ❌ restart, Node module-cache pins the old code, **and they can't import app modules** |

Two structural facts drive this ADR:

1. **Adding an agent requires a restart.** `AgentRuntimePlugin` calls `loadAgentDefinitions()` exactly once at `install()`; `SkillBrokerPlugin` reads `agents.yaml` once at boot. There is no file-watch on either. Yet `ExecutorRegistry` already supports runtime `register()`/`unregister()` (it uses them for A2A card refresh) — the capability is half-built.

2. **The dynamic-code plugin surface is a dead end.** `workspace/plugins/*.ts` loads via `await import()` (Node module cache → no safe reload) and, because the workspace is bind-mounted *outside* the app's module tree, **cannot resolve app `lib/` or `node_modules`** (this is why `feature-notifier` had to move to `lib/plugins/` — see the 2026-06-01 fix). In-process hot-reload of arbitrary TypeScript is unsafe (stale closures) and partially impossible here. We will stop pretending this surface works.

**Observability is read-rich but ephemeral.** `/api/agents/runtime`, `/api/bus/topology`, `/api/bus/history`, the `/api/bus/subscribe` WebSocket, cost/confidence summaries, and `/api/ceremonies` already expose live state without logs — but it is **in-memory** (the bus-history ring is a 30-min buffer; fleet-health is a 24 h in-memory rollup; restart wipes it). "See what's going on without logs" is ~80 % there for *reads*, but nothing survives a restart and there is no single pane that unifies the registries + their live health.

**Prior art.** ORBIS already solved the *consumer* side of this for its delegate layer: `config/delegates.yaml` is a hot-reloaded, file-backed registry with full CRUD (`/api/delegates` + a Settings UI), a health-probe loop, and SSE state — adding a delegate is a UI form, zero restart. protoAgent's ADR 0001 is the reference for the *mature* shape: four extension tiers (tools / skills / plugins / MCP), lazy manifest discovery, **capability grants** (operator-approved, off by default), and **trust tiers** (builtin / trusted / community → untrusted runs out-of-process via MCP). We are not inventing; we are generalizing ORBIS's proven pattern into the fleet host and borrowing protoAgent's trust model.

---

## 2. Constraints we must honor (already decided)

1. **The bus is the contract.** Plugins communicate only through typed topics; no plugin holds a reference to another. The sole exemption is the startup **registrar** pattern writing to shared registry objects (`ExecutorRegistry`, `ChannelRegistry`). A control plane must mutate state through `command.*` topics + a registrar, not cross-plugin method calls.
2. **The debug dashboard is read-only.** [`flow-dashboard.md`](../architecture/flow-dashboard) deliberately makes the dashboard a read-only, in-memory, Tailnet-only *observability* pane — "not a control surface." We do **not** bolt write onto it. The control plane is a **separate, auth-gated surface** ([Decision D1](#3-decision)).
3. **No in-process hot-swap of arbitrary code.** Node's module cache and the workspace-module-resolution wall make it unsafe and partly impossible. Code extension is **out-of-process** (A2A / MCP) or **compiled-in** (image deploy).
4. **Federate, don't replace the bus.** Multi-node is a `BusBridgePlugin` to NATS/Redis, not a new bus. The control plane is local-first and bridges later.
5. **No world-model / planner.** The dispatcher stays stateless routing. A control plane is configuration + observability, not agency — if tempted to add "goal" or "world state," a cron or webhook does the job.
6. **Greenfield-strict.** When a surface is replaced, it is removed, not shimmed. The broken `workspace/plugins/*.ts` loader is **retired**, not kept "for compatibility."

---

## 3. Decision

**Build a fleet control plane: a uniform layer of file-backed, hot-reloadable registries, mutated through a write API + `command.*` bus topics + a registrar, surfaced by a dedicated management UI, with durable + unified live state. The units of extension are external agents (A2A), MCP servers, and declarative rituals (ceremonies / workflows) — not hot-loaded in-process code.**

The three forks, resolved:

- **D1 — Separate control surface.** The control plane is its own auth-gated management surface (its own routes + UI section), **distinct** from the read-only debug dashboard. The dashboard stays read-only; this ADR does not amend that decision — it adds a sibling.
- **D2 — Extension = external + declarative, never runtime code.** "Add a plugin via the UI" means: register an **A2A agent**, register an **MCP server** (new MCP-client tier), add a **ceremony/declarative workflow**, or define a **DeepAgent** (YAML). Arbitrary TypeScript plugins stay **compiled-in** (image deploy). The dynamic `workspace/plugins/*.ts` loader is **retired**.
- **D3 — Durable + unified state.** Registries are file-backed (already the durable source of truth). The observability snapshots that matter (fleet-health rollups, skill outcomes, cron/ceremony run history) are **persisted** so they survive restart, and every registry + its live health is exposed through **one** control-plane read surface.

---

## 4. Architecture

### 4.1 The Registry abstraction (the spine)

Every extensible unit conforms to one shape — a **file-backed, hot-reloaded registry**:

```
workspace/<unit>.yaml ──(file watch, ~5s)──▶ Registry.reload()
        ▲                                          │
        │ atomic write                             ▼
  ControlPlaneRegistrar ◀── command.<unit>.{add,update,remove} ◀── write API (CRUD)
                                                   │
                                          ExecutorRegistry / scheduler / channels
                                          register() · unregister() · dispose()
```

- **Source of truth = the YAML file** (durable, git-trackable, diffable). The DB never owns config.
- **Hot-reload = file watch**, the pattern `ChannelRegistry` and `CeremonyPlugin` already prove (5 s poll, debounced, diff-and-apply). Generalize it; don't reinvent per-unit.
- **Mutation = write API → `command.<unit>.*` topic → registrar writes the YAML → the watcher applies it.** The write path and the read path are separate. The registrar is the documented bus-contract exemption (it owns a shared registry object).

This is deliberately the **ORBIS `/api/delegates` pattern**, generalized to agents, A2A endpoints, ceremonies, crons, channels, and MCP servers.

### 4.2 Agent hot-reload (closes the biggest gap)

`AgentRuntimePlugin` and `SkillBrokerPlugin` gain a file-watch + diff-apply:

- **Added / changed agent** → validate the YAML; construct the executor (`DeepAgentExecutor` for in-process, A2A registration for remote); `ExecutorRegistry.register(skill, executor)` for each declared skill.
- **Removed agent** → `ExecutorRegistry.unregister(skill, agentName)` (already exists) + **dispose** the executor (new lifecycle hook) so in-flight work drains and resources free.
- **Concurrency**: apply diffs on the bus turn, never mid-dispatch; a replaced executor finishes in-flight requests before disposal.

`ExecutorRegistry` is already most of the way here (it unregisters on A2A card refresh). The new work is **executor lifecycle** (construct/dispose) and the **watch + diff**.

### 4.3 Control plane = write API + command topics + registrar

- **REST (auth-gated, admin key):** `POST/PUT/DELETE /api/agents`, `/api/a2a-endpoints`, `/api/crons`, `/api/mcp-servers`; `/api/ceremonies` already exists and is the template. Each validates, then publishes `command.<unit>.{add,update,remove}`.
- **`command.<unit>.*` bus topics** carry the mutation. A single **ControlPlaneRegistrar** subscribes, validates against the registry schema, and performs the atomic YAML write. The file watcher (§4.1) then reloads. This keeps every mutation on the bus (auditable in bus-history) and the registrar as the only writer.
- **Test-before-save:** `POST /api/<unit>/test` probes reachability + fetches the agent card (see §4.5) before persisting — ORBIS's pattern, so the UI never saves a dead endpoint.

### 4.4 Management UI (the separate control surface)

A dedicated, auth-gated **Console** surface (its own section, distinct from the read-only debug dashboard):

- CRUD for each registry (agents, A2A endpoints, MCP servers, ceremonies, crons, channels) — add / edit / delete / test, mirroring ORBIS's `DelegatesSettings`.
- A live **fleet view**: every registry + per-entry health (reachable / latency / last error) + recent run history — the "what's going on without logs" pane, fed by §4.6.
- Capability discovery rendered read-only (§4.5).

It consumes the write API (§4.3) for mutations and the unified read surface (§4.6) for state. It may live in the same app as the dashboard but is a clearly-separated, write-capable surface — never the read-only debug pane.

### 4.5 Capability discovery (closes ORBIS's gap, powers the UI)

On add/test of an A2A agent or MCP server, fetch its descriptor (`/.well-known/agent-card.json` for A2A; the tool list for MCP), cache its skills/tools, and surface them read-only in the UI. `SkillBrokerPlugin` already fetches agent cards for skill registration — extend it to expose the cached card to the control plane. The operator picks from **real capabilities**, not a free-text guess (ORBIS's current weak spot), and the registry records what each agent actually does.

### 4.6 Durable + unified state

- **Registries** are file-backed already — durable by construction.
- **Persist the snapshots that matter** — fleet-health rollups, skill outcomes, and cron/ceremony run history — to the existing SQLite store, so they survive restart. The live bus ring stays in-memory (ephemeral by nature) but is backed by the durable event log for history.
- **One read surface** — a control-plane state endpoint (and the Console pane) that renders every registry + live health + recent runs in one place. This is the explicit answer to "see what's going on without logging."

### 4.7 Extension tiers (what "pluggable" means here — borrowing protoAgent ADR 0001)

| Tier | Unit | Add via | Isolation | Hot-swappable |
|---|---|---|---|---|
| **Agent — remote** | A2A service | control plane (register endpoint) | out-of-process | ✅ |
| **Agent — in-process** | DeepAgent YAML | control plane / `workspace/agents/` | in-process (trusted, first-party) | ✅ (after §4.2) |
| **Capability/tool** | MCP server | control plane (register server + grants) | out-of-process | ✅ |
| **Ritual** | ceremony / declarative workflow | control plane / `workspace/ceremonies/` | declarative | ✅ |
| **Code plugin** | TS in `lib/plugins/` | image build + deploy | in-process | ❌ (by design) |

**Capability grants + trust tiers** (protoAgent ADR 0001): external agents and MCP servers declare the capabilities they need (network egress, secrets, etc.); the operator approves them at add-time in the Console; a trust tier (`builtin > trusted > community`) gates what auto-enables. This is the safety boundary that lets us add untrusted external extensions without a rebuild.

---

## 5. Phased plan (impact → effort)

1. ✅ **P1 — Agent registry hot-reload** *(shipped — #714 watch+detect, #715 apply).* `WorkspaceWatcher` (reusable poll-based file/dir diff) watches `workspace/agents/`; `AgentRuntimePlugin` reconciles the live registry via `ExecutorRegistry.register`/`unregister` + `IExecutor.dispose?()`. Add/edit/remove a DeepAgent YAML applies in ~5s, no restart; a parse error keeps the running agent; in-flight dispatch is never aborted. *(`workspace/agents.yaml` A2A entries still need a restart — extends in a later slice.)*
2. **P2 — Control-plane write API + `command.*` + registrar** for agents (then crons/channels), modeled on the existing `/api/ceremonies` CRUD. Create/edit/remove an agent via API → persisted → live, no restart.
3. **P3 — Management UI (separate Console surface) + capability discovery** (agent-card/MCP probe + test-before-save), mirroring ORBIS `DelegatesSettings`.
4. **P4 — MCP client tier + capability grants + trust tiers**; **retire the `workspace/plugins/*.ts` loader**. (Larger — likely its own sprint.)
5. **P5 (cross-cutting) — Durable + unified state**: persist fleet-health / outcomes / run-history; one control-plane read view.

---

## 6. Week-1 sprint

Scope: land **P1 + P2 + P3** and the durable/unified-state slice of **P5**, leaving **P4** (MCP + grants + trust tiers) for a following sprint. One PR per day, each green + tested, each shippable on its own.

| Day | Goal | Deliverable / PR | Acceptance |
|---|---|---|---|
| **1** | Registry abstraction + agent file-watch (detect only) | Extract the shared file-watch/diff helper (from the Channel/Ceremony pattern); arm it on `workspace/agents/` + `agents.yaml`; log computed add/change/remove diffs — no apply yet. | Editing an agent YAML logs the correct diff within ~5 s; tests on the diff logic. |
| **2** | P1 — apply the diff (hot-reload agents) | Executor lifecycle (`dispose()`); `AgentRuntimePlugin`/`SkillBroker` apply diffs via `ExecutorRegistry.register`/`unregister`; drain in-flight before dispose. | Add/edit/remove an agent YAML → live in `/api/agents/runtime` with **no restart**; in-flight dispatch isn't dropped; tests. **Ship P1.** |
| **3** | P2 — control-plane write API | `POST/PUT/DELETE /api/agents` + `command.agent.*` + `ControlPlaneRegistrar` (atomic YAML write) + `/api/agents/test`. Reuse the `/api/ceremonies` CRUD shape. | Create an agent via API → persisted to YAML → live (via P1) → no restart; auth-gated; mutations visible in bus-history; tests. **Ship P2.** |
| **4** | P3 — Console surface + capability discovery | Separate auth-gated management pane: agent CRUD + test-before-save + agent-card capability probe surfaced read-only. (A2A endpoints next.) | Add/edit/remove an agent + an A2A endpoint from the UI, with a reachability/card test before save; the debug dashboard stays read-only. |
| **5** | P5 slice — durable + unified state + docs | Persist fleet-health + cron/ceremony run-history to SQLite; one control-plane read view; update `flow-dashboard.md` to name the read/write split; sprint retro. | State survives restart; one pane shows registries + health + recent runs; ADR + docs updated. |

P4 (MCP client, capability grants, trust tiers, retiring the workspace-plugin loader) is a scoped follow-up sprint — it introduces a new external-tool tier and a trust/grant model and deserves its own ADR slice.

---

## 7. Consequences

**Positive**
- Adding/modifying agents, A2A endpoints, crons, channels, and (later) MCP tools is **UI-driven and hot-swappable** — no rebuild, no restart.
- One uniform registry abstraction replaces five ad-hoc loaders → less code, consistent behavior, easier to extend to the next unit.
- Live state is **durable + unified** — "what's the fleet doing" is answerable from one pane, across restarts, without logs.
- Untrusted extension is safe by construction (out-of-process A2A/MCP + capability grants), not by trusting hand-loaded code.
- The bus stays the contract (mutations are `command.*` topics, auditable in bus-history); the debug dashboard stays read-only.

**Costs / risks**
- Executor lifecycle + diff-apply must be careful about in-flight work and concurrent mutation (drain-before-dispose; apply on the bus turn).
- A new **write/control surface** is new attack surface — strictly auth-gated, Tailnet-scoped like the rest.
- Persisting observability adds a small storage + write-path cost (bounded; rollups + run-history, not the full firehose).
- Retiring `workspace/plugins/*.ts` removes a (broken) surface — first-party plugins move to `lib/plugins/` (already the working path; `feature-notifier` set the precedent).

---

## 8. Alternatives considered

- **A visual workflow / node-programming editor (the "N8N canvas" read of this ADR).** **Rejected — explicitly and firmly.** This is a switchboard, not a workflow engine (see `CLAUDE.md` "What this app is NOT"). N8N-style data-flow programming — drawing `node.output → node.input` to author logic — is the rejected path, of a piece with the GOAP planner that was already ripped. Our model is **choreography**: triggers publish topics, subscribers react, and the intelligence lives *in* the agent nodes (they reason), not in a human-drawn graph. The Console's topology view (§4.4) may become *interactive* — wiring routing (who reacts to what) and watching live dispatches flow through the graph — but it **never** becomes a surface for authoring logic. If genuine multi-step orchestration is ever needed, the on-brand path is declarative workflows over subagents (protoAgent ADR 0002, YAML, no arbitrary code), optionally *rendered* on the canvas — not a node editor.
- **Hot-reload arbitrary in-process TS plugins.** Rejected — Node module cache pins old code, stale closures are unsafe, and workspace plugins can't resolve app modules anyway. Out-of-process (A2A/MCP) is the correct isolation boundary.
- **Make the existing dashboard the control surface.** Rejected — it's a deliberately read-only, in-memory debug pane; a write path there muddies the charter and the security posture. A separate, auth-gated Console keeps the split clean.
- **A config DB as source of truth.** Rejected — YAML-in-workspace stays the source of truth (git-trackable, diffable, matches the fleet idiom); the DB only persists *observability snapshots*, never config.
- **Do nothing / restart-to-extend.** Rejected — the whole point is to extend without rebuilds; and the workspace-plugin surface is already broken, so the status quo is worse than it looks.

---

## 9. Related

- [ADR-0001 — Org→execution pipeline](./0001-org-to-execution-pipeline) · [ADR-0002 — protoMaker boundary](./0002-workstacean-protomaker-integration-boundary)
- [`flow-dashboard.md`](../architecture/flow-dashboard) — the read-only debug pane this ADR keeps read-only.
- protoAgent **ADR 0001** (Extensibility & Plugin Architecture — tiers, manifests, capability grants, trust tiers), **ADR 0002** (Reusable Subagent Workflows), **ADR 0005** (Tool Pollution & Progressive Disclosure — the tool-bloat lens already applied to Ava).
- ORBIS `config/delegates.yaml` + `/api/delegates` + `DelegatesSettings.tsx` — the proven hot-reloadable-registry-with-CRUD-UI pattern this generalizes.
- Code anchors: `src/executor/executor-registry.ts` (`register`/`unregister`), `src/agent-runtime/agent-runtime-plugin.ts` (boot-only load → add watch), `src/plugins/CeremonyPlugin.ts` + `lib/channels/channel-registry.ts` (the file-watch pattern to generalize), `src/api/operations.ts` (`/api/ceremonies` CRUD template).

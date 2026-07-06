---
title: "ADR-0008: Visual Orchestration Surface — One Command Hub over the Agent Fleet"
---

# ADR-0008: Visual Orchestration Surface — One Command Hub over the Agent Fleet

- **Status:** Proposed — 2026-06-07 (model corrected 2026-06-08: one command hub, not peer-node federation)
- **Deciders:** Josh (operator)
- **Related:** [ADR-0004](./0004-fleet-control-plane-and-hot-swappable-extension) (this **reframes** its §8 rejection of the "N8N canvas"; builds on its registries + control-plane API + `SystemGraph`); [ADR-0007](./0007-workstacean-as-fleet-a2a-gateway) (the gateway is **the** distribution mechanism — one front door over remote A2A agents); [ADR-0005](./0005-mcp-client-tier-and-trust-tiers) (trust tiers gate which A2A agents you admit)
- **Tags:** architecture, ux, orchestration, canvas, a2a, observability

> protoLabs wants the **ComfyUI / n8n of agent orchestration** — in *function and UX* — over a fleet of **distributed agents** *and* built-in ones. The model is **one command hub**: workstacean is the single brain that commands every agent. The distributed agents are **A2A agents** physically running on other machines (ORBIS, pwnDeck, protoAgent), reached through workstacean's **A2A gateway (ADR-0007)** — that gateway *is* the distribution. Workstacean can also **spawn its own in-process agents** (Ava, Quinn, researcher). The canvas is this one hub's view of every agent it commands — in-process + A2A — with live dispatch flowing through. The field splits into a desirable **UX/extensibility ethos** (visual canvas, node palette, hot-swap, self-host, live execution) and an **execution model** (the human draws a data-flow DAG and the graph *is* the logic). ADR-0004 firmly rejected the second; it never rejected the first. **We take the UX and keep choreography** — the "nodes" are *reasoning agents*, the canvas authors **wiring** and **renders** declarative workflows, and it never becomes a surface for `node.output → node.input` logic. "UX yes, logic-authoring no."

---

## 1. Context & problem

**The ask.** Make protoWorkstacean the visual, node-based, extensible, self-hosted orchestration surface for the fleet — function *and* UX — spanning the **distributed agents** *and* the built-in in-process ones.

**The topology.** There is **one command hub** — workstacean. It is *not* one of many peer nodes; there is no second workstacean and no hub-to-hub federation. Distribution comes from the **agents** living on different machines, reached over **A2A**. Two node tiers, one brain:
- **built-in** — in-process DeepAgents the hub *spawns* (Ava, Quinn, researcher, protobot), dispatched via `DeepAgentExecutor`.
- **a2a** — remote agents the hub *commands*, running on other machines (ORBIS, pwnDeck, protoAgent), dispatched via `A2AExecutor` behind the **ADR-0007 gateway** (`/a2a/<agent>`, per-agent cards, transparent proxy).

**The field (2026).** [ComfyUI](https://github.com/comfy-org/ComfyUI) is a lazily-evaluated DAG; extensibility is `custom_nodes/` packs. [n8n](https://jimmysong.io/blog/n8n-deep-dive/) is a drag-drop node editor (400+ integrations, community nodes on npm, self-host) whose newer [AI Agent / "cluster" nodes](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/) are a *root node that reasons*. [Flowise/Langflow/Dify/Rivet](https://toolhalla.ai/blog/dify-vs-flowise-vs-langflow-2026) are visual builders over LangChain/LangGraph. **The market is converging toward our bet** — agents reason; you orchestrate and observe them — but with a canvas UX we lack.

**The tension we resolve.** ADR-0004 §8 rejected "the N8N canvas" *"explicitly and firmly… choreography… the topology view may become **interactive**… but it **never** becomes a surface for authoring logic."* That rejection is of **data-flow logic authoring**; it *already blessed* an interactive topology + rendered declarative workflows. This ADR is that future arriving — it **reframes** §8, not overturns it.

**One hub makes this simple — most of the hard parts vanish.** Because workstacean is the single dispatcher, **it already sees every dispatch** — in-process and out to a distributed A2A agent — on its **one local bus** (`flow.item.*`, `agent.runtime.*`). So:
- The live-execution canvas is **already data-complete on one node** — no bus bridging, no NATS/Redis, no cross-hub mirroring.
- The node palette is **already the local `ExecutorRegistry`**, which already unifies in-process + A2A executors.
- There is no "which node owns Ava" question — the hub owns its in-process agents; A2A agents are owned by their own machines and merely *commanded* through the gateway.

**The substrate is largely built.** Hot-swappable registries + control-plane write API + CRUD Console (ADR-0004 P2–P5) = the palette and the add-a-node path. `SystemGraph` is a live ReactFlow topology whose edges animate on bus traffic — a canvas today, read-only. `flow.item.*` is a graph-shaped execution model (in-memory). **protoAgent is the extensible node substrate** — it already ships a declarative **workflow DAG engine** (`graph/workflows/engine.py` — YAML steps, `depends_on`, mustache `steps.<id>.output` templating, cycle detection, parallel exec), a zero-coupling **plugin** system, the portable **AgentSkills `SKILL.md`** standard, and MCP. The gap is the *surface*, not the substrate.

---

## 2. Constraints we must honor (already decided)

1. **Choreography, not a data-flow engine (ADR-0004 §8; CLAUDE.md "is NOT a workflow engine").** Logic lives **in the agents** (they reason) and in **declarative YAML**, never in a human-drawn `output→input` graph. This ADR **reframes** ADR-0004 §8 for *observability + wiring + rendering*; the "never a surface for authoring [data-flow] logic" line **stands**.
2. **The bus is the contract (ADR-0004).** The canvas reads bus state; wiring edits write declarative config via the **registrar**. No new dispatch path.
3. **A2A = agents, MCP = tools (ADR-0005, ADR-0007).** Agent nodes address through the A2A gateway; tool nodes stay MCP. Dual gateway holds.
4. **One command hub.** Distribution is **A2A agents on many machines**, not many workstacean nodes. *(If multiple workstacean hubs are ever needed for HA/scale, that is the separate `CLAUDE.md` § Multi-node `BusBridgePlugin`→NATS/Redis concern — **orthogonal to this ADR and explicitly out of scope here**. Do not conflate the two.)*
5. **Greenfield.** The read-only dashboard evolves into the canvas; we don't keep two surfaces.

---

## 3. Decision

**protoWorkstacean is the fleet's single command hub *and* its visual orchestration surface: a live canvas whose nodes are *reasoning agents* in two tiers — built-in (in-process, spawned here) and a2a (distributed, commanded here via the ADR-0007 gateway) — sourced from the local `ExecutorRegistry`, executing over the hub's one bus, with the canvas authoring *wiring* and *rendering* declarative workflows, but never authoring data-flow logic.**

Resolved forks:

- **D1 — Reconcile, not overturn (UX yes, logic-authoring no).** Adopt ComfyUI/n8n's **UX + extensibility ethos**; reject their **execution model**. The canvas does four things — (a) a **node palette** of fleet agents/MCP-tools/protoAgent-plugins, drag-to-add (writes via the control-plane API), (b) **live execution** flowing across the graph, (c) **wiring** authoring (who-reacts-to-what), (d) **rendered** declarative workflows. It does **not** offer `node.output → node.input` logic drawing. Formally amends ADR-0004 §8.
- **D2 — Two tiers, both reasoning agents.** Every node is an agent or tool, tagged `builtin` (in-process) or `a2a` (remote, on some machine). The intelligence is *in* the node; the canvas never encodes it. No "peer-fleet" tier — there are no peer hubs.
- **D3 — A2A is the distribution; the canvas needs no federation.** Distributed agents are reached via the **ADR-0007 A2A gateway** (resolve `<agent>` → `A2AExecutor` → proxy to its machine). Because the hub dispatches everything, the live view is built from the **one local bus** — no `BusBridgePlugin`, no NATS/Redis, no cross-node mirroring. The canvas *observes* the local bus; the gateway *acts* across the network.
- **D4 — The palette is the local registry.** The node palette is rendered from the live `ExecutorRegistry` (already a union of in-process + A2A + MCP executors) plus protoAgent plugins/skills surfaced as installable node packs. Add-a-node = the existing control-plane write API + registrar; no announce/discovery protocol across hubs is needed.
- **D5 — Wiring authoring writes declarative config.** Drawing an edge "when A emits X, B reacts" writes a subscription/route through the **registrar** (`channels.yaml` / agent YAML / a `routes.d/`). Never code, never data-flow. Multi-step logic is a **declarative workflow** (D6), rendered read-only.
- **D6 — Declarative workflows, borrowed and rendered.** Lift protoAgent's YAML DAG engine to a first-class `WorkflowExecutor` node-type (built fresh at P3 — an earlier unwired stub was removed once nothing registered it). A workflow step may **target any agent the hub commands** — including a distributed A2A agent (the gateway handles the hop). The canvas **renders** the DAG (read-only diagram from YAML) and shows it executing live; it is not authored by drawing.
- **D7 — Trust gates which A2A agents you admit (ADR-0005 tiers).** A remote A2A agent enters the palette only at a trust tier you grant; ADR-0007 A2A auth + ADR-0005 tiers decide admission and whether the hub may dispatch to it. Untrusted endpoints are invisible/inert, not auto-wired.

---

## 4. Architecture

```text
                    ┌──────────────  THE CANVAS  ──────────────┐
                    │  palette · live execution · wiring ·      │
                    │  rendered workflows                       │
                    └───────────────────▲──────────────────────┘
                            reads the ONE local bus
                            (ExecutorRegistry + flow.item.*)
   ┌────────────────────────────────────┴──────────────────────────────────┐
   │  workstacean — THE COMMAND HUB  (one node, one bus)                     │
   │   InMemoryEventBus · RouterPlugin · SkillDispatcher                     │
   │   ExecutorRegistry.resolve(skill, target) →                            │
   │     ┌─ builtin  ──▶ DeepAgentExecutor : ava · quinn · researcher        │
   │     └─ a2a      ──▶ A2AExecutor ──┐  (ADR-0007 gateway /a2a/<agent>)     │
   └───────────────────────────────────┼─────────────────────────────────────┘
                                        │  A2A over the network
                    ┌──────────────┬────┴─────────┬──────────────────┐
                    ▼              ▼               ▼                  ▼
                   ORBIS@host      pwnDeck            protoAgent
                    └──────────  distributed A2A agents (own machines)  ──────┘

   Every dispatch — in-process OR out to a distributed A2A agent — flows through the
   hub's dispatcher, so the canvas sees it all from the one local bus. No bridging.
```

---

## 5. Phased plan (impact → effort)

| Phase | Slice | De-risks |
|---|---|---|
| **P1 — The live canvas (the keystone)** | Persist `flow.item.*` to `knowledge.db`; make `SystemGraph` the primary surface; render the palette from `ExecutorRegistry` (builtin + a2a + mcp); animate a live dispatch — *including one out to a distributed A2A agent like pwnDeck@steamdeck* — flowing through the graph, with history + replay. | The whole thesis, on one hub, with assets that exist — **no federation needed.** This alone is the demo. |
| **P2 — Wiring authoring** | Draw a subscription/route → registrar writes declarative config. | The "author wiring, not logic" line, in UX. |
| **P3 — Workflows, rendered** | `WorkflowExecutor` over protoAgent's YAML DAG; render + live-trace; steps may target distributed A2A agents via the gateway. | Multi-step orchestration without a logic-authoring canvas. |
| **P4 — Palette as marketplace + admission** | Surface protoAgent plugins/skills + MCP as installable node packs; trust-tier admission UX for registering A2A agents. | The extensibility / "ecosystem" story (ADR-0005/0007). |

**The keystone is P1** — a live canvas showing the hub command both an in-process agent and a distributed A2A agent, drawn from one bus. It proves the vision end-to-end with nothing exotic.

---

## 6. Consequences

- **Delivers the ask, on-brand and *simple*.** A genuine ComfyUI/n8n-class UX (palette, live canvas, self-host, extensible) without becoming a workflow engine, and without distributed-systems machinery — one hub, one bus, A2A for reach.
- **Differentiated.** Every competitor is a function-box DAG; ours is a live canvas of *reasoning agents* the hub commands across machines.
- **No federation tax.** Because the hub already dispatches and observes everything, the live cross-machine execution view needs zero bridging — the hardest part of the earlier (discarded) "peer-node" model is gone.
- **Cost & risk.** New: a durable `flow.item` store; significant `dashboard/` work to turn read-only panes into the canvas; the canvas must stay *fast* under `flow.item` volume (retention + sampling). Trust/admission for A2A agents leans on ADR-0005 + ADR-0007.
- **Doctrine updates on acceptance.** `CLAUDE.md` § "What this app is NOT" gets a precise carve-out (canvas = observability/wiring/rendering, *not* data-flow authoring); ADR-0004 §8 already carries a forward-pointer here.

---

## 7. Open questions (resolve at implementation)

- **Scale of the commanded fleet.** How many A2A agents, how busy? Drives `flow.item` volume, retention, sampling, and canvas render performance.
- **Canvas hosting & auth.** Keep the Tailnet-scoped, admin-keyed dashboard model (ADR-0004 §4.4)? Single operator, or shared view?
- **Distributed-step resilience in workflows.** When a workflow step targets a distributed A2A agent that's slow/down, the gateway proxy + `TaskTracker` rehydration already partly handle it — verify the rendered live-trace reflects retries/escalations cleanly.
- **`flow.item` durability vs cost.** Retention window + storage shape in `knowledge.db` so historical browse/replay works without unbounded growth (cf. the events.db retention lessons).
- **Explicitly NOT in scope:** multiple workstacean hubs / hub-to-hub federation (the `CLAUDE.md` § Multi-node `BusBridgePlugin`→NATS/Redis path). That stays a separate, someday concern; this ADR is one command hub.

---

## 8. Related

- [ADR-0004](./0004-fleet-control-plane-and-hot-swappable-extension) — registries, control-plane API, `SystemGraph`; **§8 reframed here**.
- [ADR-0005](./0005-mcp-client-tier-and-trust-tiers) — trust tiers, reused for A2A-agent admission (D7).
- [ADR-0007](./0007-workstacean-as-fleet-a2a-gateway) — the agent-addressing/proxy gateway that *is* the distribution mechanism.
- `CLAUDE.md` § *What this app is NOT* — the choreography line this preserves; § *Multi-node* — the separate, out-of-scope BusBridge concern.
- protoAgent (`graph/workflows/engine.py`, `graph/plugins/`, AgentSkills) — the extensible node substrate the palette surfaces.

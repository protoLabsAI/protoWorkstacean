---
title: "ADR-0008: Visual Orchestration Surface for a Federated Fleet"
---

# ADR-0008: Visual Orchestration Surface for a Federated Fleet

- **Status:** Proposed — 2026-06-07
- **Deciders:** Josh (operator)
- **Related:** [ADR-0004](./0004-fleet-control-plane-and-hot-swappable-extension) (this **reframes** its §8 rejection of the "N8N canvas" — see §2; builds on its registries + control-plane API + `SystemGraph`); [ADR-0007](./0007-workstacean-as-fleet-a2a-gateway) (the gateway is the federation's *agent-addressing* substrate — "one front door… peer node"); [ADR-0005](./0005-mcp-client-tier-and-trust-tiers) (trust tiers gate which cross-fleet agents enter the canvas); `CLAUDE.md` § *Multi-node* (the decided `BusBridgePlugin` → NATS/Redis direction this finally surfaces)
- **Tags:** architecture, ux, orchestration, federation, multi-node, canvas, observability

> protoLabs wants the **ComfyUI / n8n of agent orchestration** — in *function and UX* — for a **multi-fleet, distributed** set of agents *and* the built-in ones. The field splits into two separable things: a desirable **UX & extensibility ethos** (visual canvas, node palette, hot-swap, self-host, marketplace, live execution you can *watch*) and an **execution model** (the human draws a data-flow DAG and the graph *is* the logic). ADR-0004 firmly rejected the second; it never rejected the first. This ADR **takes the UX, keeps choreography** — the canvas's "nodes" are *reasoning agents* (built-in, local-A2A, and on peer fleets), the canvas authors **wiring** (who reacts to what) and **renders** declarative workflows, and the live-execution view federates across nodes. We become "ComfyUI/n8n where the nodes are autonomous agents, not function boxes" — and because we federate over a *topic bus* rather than a drawn DAG, distribution is native, not bolted on.

---

## 1. Context & problem

**The ask.** Make protoWorkstacean the visual, node-based, extensible, self-hosted orchestration surface for the fleet — function *and* UX — spanning **multi-fleet distributed agents** as well as the built-in in-process ones.

**The field (2026).** [ComfyUI](https://github.com/comfy-org/ComfyUI) is a lazily-evaluated DAG where workflows serialize to JSON and extensibility is `custom_nodes/` packs. [n8n](https://jimmysong.io/blog/n8n-deep-dive/) is a drag-drop node editor with 400+ integrations, **community nodes on npm**, self-host, and — tellingly — its newer [AI Agent / "cluster" nodes](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/) are a *root node that reasons* with sub-nodes for memory/tools. [Flowise/Langflow/Dify/Rivet](https://toolhalla.ai/blog/dify-vs-flowise-vs-langflow-2026) are visual builders over LangChain/LangGraph. **The market is converging toward *our* bet** — agents reason; you orchestrate and observe them — but with a canvas UX we lack.

**The tension we must resolve.** ADR-0004 §8 rejected "the N8N canvas" *"explicitly and firmly… this is a switchboard, not a workflow engine… choreography… the topology view may become **interactive**… but it **never** becomes a surface for authoring logic."* The operator's directive could read as *overturning* that. It does not have to: the ADR-0004 rejection is of **data-flow logic authoring**, and it *already blessed* an interactive topology + rendered declarative workflows as the on-brand future. This ADR is that future arriving.

**The distributed twist makes choreography the *right* answer, not a compromise.** n8n needed [queue-mode + Redis workers](https://jimmysong.io/blog/n8n-deep-dive/) to scale precisely because a centrally-drawn DAG is one execution bottleneck; ComfyUI's distributed-node story is famously painful for the same reason — the graph is centralized logic. **Pub/sub choreography federates natively:** a trigger publishes, subscribers react, across machines it's just a bridged topic. The thing competitors fight to distribute, we get free by *not* adopting their execution model.

**We already hold most of the substrate.**
- Hot-swappable registries (agents / A2A / MCP / ceremonies) + a control-plane write API + a CRUD Console (ADR-0004 P2–P5) = the *node palette* and the *add-a-node* path.
- `SystemGraph` — a live **ReactFlow** topology whose edges animate on bus traffic (`dashboard/`) = a canvas, today, read-only.
- `flow.item.{created,updated,completed}` events (status / stage / causality via `correlationId`+`parentId`) = a graph-shaped execution model, currently in-memory only.
- **ADR-0007** makes every agent — in-process or remote — addressable through one gateway with a per-agent card, and already names "**peer node**" callers = the agent-addressing layer the federation needs.
- `CLAUDE.md` § *Multi-node* already **decided** the transport answer: a `BusBridgePlugin` bridging the local `InMemoryEventBus` to **NATS or Redis** (don't replace the bus — bridge it), mirroring topics to/from peer nodes.
- **protoAgent is the extensible node substrate.** It already ships a declarative **workflow DAG engine** (`graph/workflows/engine.py` — YAML steps, `depends_on`, mustache `steps.<id>.output` templating, cycle detection, parallel exec), a zero-coupling **plugin** system (manifest + `register(registry)`, hot-loadable), the portable **AgentSkills `SKILL.md`** standard (FTS5-indexed, self-emitting), and MCP. Its plugins/skills/workflows *are* the "node packs."

**What's missing is the surface and the federation wiring above this substrate — not the substrate.**

---

## 2. Constraints we must honor (already decided)

1. **Choreography, not a data-flow engine (ADR-0004 §8; CLAUDE.md "is NOT a workflow engine").** Logic lives **in the agents** (they reason) and in **declarative YAML**, never in a human-drawn `output→input` graph. This ADR **reframes** ADR-0004 §8 — the canvas is embraced for **observability + wiring + rendering**, and the "never a surface for authoring [data-flow] logic" line **stands**. ADR-0004 is amended, not superseded.
2. **The bus is the contract (ADR-0004).** Federation = bridging topics, not a new dispatch path. The canvas reads bus state; wiring edits write declarative config via the **registrar**.
3. **A2A = agents, MCP = tools (ADR-0005, ADR-0007).** Canvas nodes that are *agents* address through the A2A gateway; *tools* stay MCP. Dual gateway holds.
4. **Don't replace `InMemoryEventBus` — bridge it (CLAUDE.md § Multi-node).** Federation is a `BusBridgePlugin`, mirror-configured per node. Stateful in-process executors are *owned* by a node, not magically distributed.
5. **Greenfield.** The read-only dashboard evolves into the canvas; we don't keep two surfaces.

---

## 3. Decision

**protoWorkstacean becomes the fleet's visual orchestration surface: a live canvas whose nodes are *reasoning agents* across three tiers — built-in (in-process), local-A2A, and remote peer-fleet — sourced from a *federated* registry, executing over a *federated* event bus, with the canvas authoring *wiring* (subscriptions/routing) and *rendering* declarative workflows, but never authoring data-flow logic.**

Resolved forks:

- **D1 — Reconcile, not overturn (UX yes, logic-authoring no).** Adopt ComfyUI/n8n's **UX + extensibility ethos**; reject their **execution model**. The canvas does four things — (a) a **node palette** of fleet agents/MCP-tools/protoAgent-plugins, drag-to-add (writes via the control-plane API), (b) **live execution** flowing across the graph, (c) **wiring** authoring (who-reacts-to-what), (d) **rendered** declarative workflows. It does **not** offer `node.output → node.input` logic drawing. This formally amends ADR-0004 §8.
- **D2 — Nodes are reasoning agents, tier-tagged.** Every canvas node is an agent or tool, tagged by tier: `builtin` (this node's in-process DeepAgents), `local-a2a` (tailnet/docker A2A agents), `peer-fleet` (agents owned by another workstacean node). The intelligence is *in* the node; the canvas never encodes it.
- **D3 — Federate over two existing rails, not a new one.** (i) **Bus federation** via `BusBridgePlugin` → NATS/Redis (CLAUDE.md): bridge `agent.runtime.*`, `flow.item.*`, and registry-announce topics so the canvas sees the whole fleet's *state* and *live execution*. (ii) **Agent addressing/execution** via the **ADR-0007 A2A gateway**: a cross-node dispatch resolves to a peer agent and proxies through its gateway. The canvas federates by *reading the bridged bus*; cross-node *actions* ride the gateway.
- **D4 — Federated registry + announce protocol; explicit ownership.** Each node periodically **announces the agents it owns** on a bridged `fleet.registry.announce.{node}` topic (agent name, tier, skills, card URL, health). Every node builds a **federated palette** by union-merging announces, keyed by `(node, agent)`; the canvas tags each by home + tier. This forces the `CLAUDE.md`-flagged question — *"which node owns Ava"* — to an explicit answer: **one owner per agent name per node**; collisions across nodes are distinct, addressable entries (`fleet-1/ava`, `fleet-2/ava`), never silently merged.
- **D5 — Wiring authoring writes declarative config, cross-node included.** Drawing an edge "when A emits X, B reacts" writes a subscription/route through the **registrar** (`channels.yaml` / agent YAML / a new `routes.d/`), local or — for a peer target — a bridged subscription. Never code, never data-flow. Logic-bearing multi-step orchestration is a **declarative workflow** (D6), rendered read-only on the canvas.
- **D6 — Declarative workflows, borrowed and rendered.** Lift protoAgent's YAML DAG engine to a first-class `WorkflowExecutor` node-type (the executor already exists as a stub). A workflow's steps may **span fleets** (each step runs on whichever node owns its agent, via the gateway). The canvas **renders** the DAG (read-only diagram from YAML) and shows it executing live; it is not authored by drawing.
- **D7 — Cross-fleet trust gates canvas admission (ADR-0005 tiers).** A peer fleet's agents enter your palette only at a trust tier you grant; announce-topic acceptance + A2A auth (ADR-0007) decide whether a peer's nodes appear and whether you may dispatch to them. Untrusted peers are invisible/inert, not auto-wired.

---

## 4. Architecture

```text
                         ┌──────────────  ONE CANVAS  ──────────────┐
                         │  palette (federated)  ·  live execution  │
                         │  wiring (who→what)    ·  rendered flows   │
                         └───────▲───────────────────────▲──────────┘
            reads bridged bus    │                       │  cross-node action
         (registry + flow.item)  │                       │  via A2A gateway (ADR-0007)
   ┌─────────────────────────────┼───────────┐   ┌───────┼─────────────────────────────┐
   │  NODE: fleet-1 (this host)   │           │   │  NODE: fleet-2 (peer host)          │
   │  InMemoryEventBus ──┬── BusBridgePlugin ─┼───┼─ NATS / Redis ─┬── InMemoryEventBus  │
   │   builtin: ava,quinn│   announces:       │   │                │  builtin: roxy,…    │
   │   local-a2a: protopen│  fleet.registry.   │   │                │  local-a2a: …       │
   │   ExecutorRegistry   │  announce.fleet-1  │   │                │  ExecutorRegistry   │
   │   A2A gateway /a2a/<a>│  flow.item.* ▲     │   │       flow.item.* ▲  A2A gateway     │
   └──────────────────────┴────────────────────┘   └──────────────────────────────────────┘
        bus federation = STATE + live execution view   ·   A2A gateway = cross-node dispatch
```

- **The canvas** (evolved `dashboard/SystemGraph` + persisted `flow.item.*`) is served by any node; it reads the **bridged** bus, so it shows every node's agents (palette) and every node's live dispatches (execution), one view.
- **`BusBridgePlugin`** (CLAUDE.md direction) mirrors a configured topic set to NATS/Redis and back — `fleet.registry.announce.*`, `flow.item.*`, `agent.runtime.*`. Local bus stays local; only the federation topics cross.
- **Cross-node execution** never goes "through the canvas" — it resolves the target node and dispatches via the **ADR-0007 gateway proxy**. The canvas *observes*; the gateway *acts*.

---

## 5. Phased plan (impact → effort)

| Phase | Slice | De-risks |
|---|---|---|
| **P1 — Canvas, live & persisted (single-node)** | Persist `flow.item.*` to `knowledge.db`; make `SystemGraph` the primary surface with historical browse + replay; render the agent/skill graph from the registry. | The execution-as-graph UX, on one node, with assets that exist. |
| **P2 — Federated discovery** | `BusBridgePlugin` PoC between **two local workstacean instances** over NATS/Redis; `fleet.registry.announce.*`; union-merge into **one palette** tier-tagged by node. | The hard federation question (ownership, dedup, transport) at small scale. |
| **P3 — Federated live execution** | Bridge `flow.item.*`; render a cross-node dispatch (fleet-1 builtin → fleet-2 A2A) live on the canvas. | Proves the *federated canvas* end-to-end — the keystone demo. |
| **P4 — Wiring authoring** | Draw a subscription/route → registrar writes declarative config (local + bridged). | The "author wiring, not logic" line, in UX. |
| **P5 — Workflows, rendered** | `WorkflowExecutor` over protoAgent's YAML DAG; render + live-trace on the canvas; allow fleet-spanning steps. | Multi-step orchestration without a logic-authoring canvas. |

**The keystone PoC is P2→P3:** bridge two nodes, federate their registries into one palette, and watch a cross-node dispatch animate on the canvas. That proves the whole thesis before any large build.

---

## 6. Consequences

- **Delivers the ask, on-brand.** A genuine ComfyUI/n8n-class UX (palette, live canvas, self-host, extensible) without becoming a workflow engine — choreography and the agent-as-node bet are *preserved and showcased*, not abandoned.
- **Differentiated.** Every competitor is a function-box DAG; ours is a live canvas of *reasoning agents* over a federated bus. The market is moving toward this; we'd be early and structurally ahead on distribution.
- **Distribution is native.** Federating a topic bus scales by fan-out, not by a queue-mode workaround for a central DAG.
- **Forces the deferred multi-node question to an answer** — explicit per-node agent ownership + announce/discovery — which `CLAUDE.md` said to "solve when we get there." We're there.
- **Cost & risk.** New: a durable `flow.item` store, a federated registry/announce protocol, the `BusBridgePlugin` (NATS/Redis dependency), and significant `dashboard/` work to turn read-only panes into the canvas. The canvas must stay *fast* under bridged `flow.item` volume (retention + sampling needed). Trust/security across fleets leans on ADR-0005 + ADR-0007 but adds an admission-control surface.
- **Doctrine updates on acceptance.** `CLAUDE.md` § "What this app is NOT" gets a precise carve-out (canvas = observability/wiring/rendering, *not* data-flow authoring); § *Multi-node* graduates from "decided direction" to "in build"; ADR-0004 §8 gets a forward-pointer to this ADR.

---

## 7. Open questions (resolve at implementation)

- **Transport: NATS vs Redis vs HTTP fan-out.** `CLAUDE.md` lists NATS *or* Redis. Lean **NATS** (purpose-built pub/sub fan-out, subjects map cleanly to bus topics, lightweight); Redis if it's already in the deployment and Streams suffice. HTTP fan-out only for a 2–3 node hobby scale.
- **Scale target.** A handful of operator machines, or open-ended multi-tenant? (Drives transport, the announce protocol's chattiness, and whether the canvas is single-tenant-per-fleet or a true multi-tenant console.) *Operator input pending — design P1–P3 for "handful of trusted nodes," keep the announce protocol multi-tenant-shaped.*
- **Agent ownership & failover.** If two nodes both host a "quinn," are they distinct (`fleet-1/quinn`, `fleet-2/quinn`) or a replicated pool with health-weighted routing? (ExecutorRegistry already does health-weighting *locally*; does it extend across the bridge?)
- **Canvas hosting & auth.** One designated node serves the canvas, or any? How does the Tailnet-scoped, admin-keyed dashboard model (ADR-0004 §4.4) extend to a federated, possibly multi-operator surface?
- **`flow.item` volume across the bridge.** Retention, sampling, and back-pressure so the federated live view stays real-time without flooding the bridge or the canvas.
- **Workflow ownership when steps span fleets.** Which node "drives" a fleet-spanning workflow, and what happens to it if that node restarts mid-run (the TaskTracker rehydration pattern, extended)?

---

## 8. Related

- [ADR-0004](./0004-fleet-control-plane-and-hot-swappable-extension) — registries, control-plane API, `SystemGraph`; **§8 reframed here**.
- [ADR-0005](./0005-mcp-client-tier-and-trust-tiers) — trust tiers, reused for cross-fleet admission (D7).
- [ADR-0007](./0007-workstacean-as-fleet-a2a-gateway) — the agent-addressing/proxy substrate the federation dispatches over.
- `CLAUDE.md` § *Multi-node* — the `BusBridgePlugin` → NATS/Redis direction this surfaces; § *What this app is NOT* — the choreography line this preserves.
- protoAgent (`graph/workflows/engine.py`, `graph/plugins/`, AgentSkills) — the extensible node substrate the palette surfaces.

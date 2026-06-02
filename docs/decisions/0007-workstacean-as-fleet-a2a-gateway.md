---
title: "ADR-0007: workstacean as the Fleet A2A Gateway"
---

# ADR-0007: workstacean as the Fleet A2A Gateway

- **Status:** Proposed — 2026-06-01
- **Deciders:** Josh (operator)
- **Related:** [ADR-0006](./0006-a2a-1.0-canonical-sdks-and-protolabs-conventions-layer) (the 1.0 migration this builds on — gateway needs 1.0's `tenant` + per-interface cards); [ADR-0005](./0005-mcp-client-tier-and-trust-tiers) (the *tool* tier — this ADR keeps the A2A=agents / MCP=tools split); [ADR-0004](./0004-fleet-control-plane-and-hot-swappable-extension) (ExecutorRegistry already routes skill→executor)
- **Tags:** architecture, a2a, gateway, multi-tenancy, routing, fleet

> A2A 1.0 blesses the **gateway/proxy pattern**: one endpoint fronts many downstream agents, routed by URL / header / body-`tenant`, each agent publishing its own card. workstacean is *already* a switchboard that fronts the fleet behind one `/a2a` — it just does so with one aggregate card and a `tenant: ""` stamp. This ADR formalizes it: **workstacean is the fleet's A2A gateway.** A caller addresses any agent — in-process (ava/quinn) or remote (roxy/protoAgent/ORBIS/pwnDeck) — through one front door, and the gateway routes to the executor or transparently proxies the remote A2A server. This unifies the in-process-vs-remote distinction at the protocol layer (the structural fix for [#750](https://github.com/protoLabsAI/protoWorkstacean/issues/750)) and makes the fleet self-describing.

---

## 1. Context & problem

- **The spec supports this directly.** [A2A multi-tenancy](https://a2a-protocol.org/latest/topics/multi-tenancy/): *"a single A2A endpoint can serve multiple agents or tenants… a gateway can inspect [the `tenant` field] and forward to the appropriate backend."* Routing strategies: **URL-based** (`/a2a/quinn`), header-based, or body-`tenant`. And: **one agent card per agent.**
- **workstacean already half-implements it.** One `/a2a` endpoint, routing by `skill`+`targets` through the `ExecutorRegistry` to in-process DeepAgents *or* proxying to remote A2A servers (A2AExecutor). But it serves **one aggregate card** (all skills mashed, tagged by agent) and stamps **`tenant: ""`** — neither uses the spec's multi-agent machinery.
- **The in-process/remote seam leaks.** Callers can't address "Quinn" as an agent; they send a skill and hope routing lands. #750 is the same seam: in-process skills bypass the task model that remote A2A tasks get. A gateway with a uniform task model closes it.
- **Goal:** be the *reference* multi-tenant A2A gateway — self-describing per-agent cards, clean routing, in-process and remote behind one door.

---

## 2. Constraints

1. **A2A = agents, MCP = tools (ADR-0005).** The gateway fronts *agents* over A2A. Tools stay MCP. workstacean is a **dual gateway** (A2A for agents + the existing MCP endpoint for tools), NOT "everything is A2A."
2. **The bus is the contract (ADR-0004).** Routing reuses the `ExecutorRegistry` (skill+target→executor); the gateway adds an *agent-addressing* layer in front, it does not replace the dispatcher.
3. **Greenfield.** The aggregate card is replaced by per-agent cards + a gateway index, not kept alongside.
4. **Sequenced after ADR-0006.** The gateway needs 1.0 `tenant` + `supportedInterfaces[]` per-agent cards. It ships *after* the wire cutover, not during it.

---

## 3. Decision

**workstacean is the fleet's A2A gateway: each fleet agent (in-process and remote) is addressable through workstacean at a per-agent URL with its own agent card; the gateway routes to the in-process executor or transparently proxies the remote A2A server. Tools remain on MCP (dual gateway).**

Resolved forks:

- **D1 — URL-based routing.** Agents are addressed at `/a2a/<agent>` with a discoverable card at `/a2a/<agent>/.well-known/agent-card.json`. Most discoverable, gives every agent a real addressable card (spec: one card per agent), cleanest mapping to the registry. The body `tenant` field rides along for org/fleet scoping, not as the primary router.
- **D2 — Dual gateway, not "everything is A2A."** A2A fronts agents; the existing MCP endpoint fronts tools. The A2A/MCP tier split from ADR-0005 holds.
- **D3 — Per-agent cards from the conventions layer.** `@protolabs/a2a`'s `buildAgentCard` is already per-agent-capable (per-agent `skills` + `url` + `tenant`). The gateway builds one card per registered agent from the `ExecutorRegistry`; the aggregate card is retired. A gateway-level index (`/.well-known/agent-card.json` at root) can advertise the gateway itself + link the per-agent interfaces.
- **D4 — Transparent proxy for remote agents.** For an in-process agent, the gateway dispatches to its executor (as today). For a remote agent, the gateway **proxies** the A2A call to that agent's own server (it is already an A2A server) — forwarding the task lifecycle, streaming, and push config. The caller sees one uniform gateway; the backend location is invisible.
- **D5 — Uniform task model (folds in #750).** Because every call goes through the gateway's task layer, in-process and remote tasks share one lifecycle (submitted/working/…); `returnImmediately` + `tasks/get` work identically regardless of where the agent runs. #750's in-process synchronous-block is resolved structurally, not patched.

---

## 4. Architecture

```text
external caller / peer node
        │  POST /a2a/<agent>           GET /a2a/<agent>/.well-known/agent-card.json
        ▼
  ┌─────────────────────────  workstacean A2A gateway  ──────────────────────────┐
  │  resolve <agent> → ExecutorRegistry                                            │
  │      in-process (ava/quinn) ──▶ DeepAgentExecutor   (dispatch on the bus)      │
  │      remote (roxy/ORBIS/…)  ──▶ A2AExecutor  ──proxy──▶ that agent's /a2a       │
  │  per-agent cards built via @protolabs/a2a buildAgentCard(agent.skills, url)    │
  └────────────────────────────────────────────────────────────────────────────────┘
        ▲
        │  (separately) MCP endpoint fronts fleet TOOLS — ADR-0005, unchanged
```

The gateway is an addressing + proxy layer in front of the existing registry. No new dispatch mechanism; it reuses ExecutorRegistry resolution and the A2AExecutor proxy path.

---

## 5. Consequences

- **One front door to the whole fleet.** Callers address any agent by name without knowing in-process vs remote. The fleet becomes self-describing (per-agent cards, declared extensions, advertised auth).
- **#750 closed structurally** — uniform task lifecycle across executor types.
- **Reference-grade exemplar** — a multi-tenant A2A gateway over a polyglot fleet; strong teaching/blog material alongside ADR-0006.
- **Cost:** per-agent card serving + an agent-resolution/proxy layer in `a2a-server.ts`; the aggregate card is retired (greenfield). Remote-proxy adds a hop, but the location-transparency is the point.
- **Sequenced post-cutover** — no work here until the ADR-0006 1.0 wire migration ships fleet-wide.

---

## 6. Open questions (resolve at implementation)

- Card signing (1.0 `signatures`) for per-agent cards — defer, or sign at the gateway?
- Streaming/push through the proxy for remote agents — verify SSE + push-callback forward cleanly across the gateway hop.
- Whether the root `/a2a` keeps a skill-routed compatibility behavior or becomes purely an index. Lean: index only (greenfield), once callers are migrated to `/a2a/<agent>`.

---
title: "ADR-0005: MCP Client Tier, Capability Grants & Trust Tiers"
---

# ADR-0005: MCP Client Tier, Capability Grants & Trust Tiers

- **Status:** Accepted — 2026-06-01
- **Deciders:** Josh (operator)
- **Related:** [ADR-0004](./0004-fleet-control-plane-and-hot-swappable-extension) (this is its **P4** slice, promised in §5/§6 as "its own ADR slice"); protoAgent ADR 0001 (Extensibility & Plugin Architecture — tiers, manifests, capability grants, trust tiers); ORBIS `config/delegates.yaml` + `/api/delegates`
- **Tags:** architecture, mcp, plugins, registry, control-plane, trust, capability-grants, hot-reload

> ADR-0004 built the fleet control plane (hot-reloadable file-backed registries, a `command.*` write API + sole registrar, a Console, durable+unified state) and shipped P1–P3 + P5. It deferred **P4** — the **MCP client tier** (register an MCP server via the control plane → its tools become available to the fleet), **capability grants + trust tiers** (operator-approved access, off-by-default for untrusted), and **retiring the broken `workspace/plugins/*.ts` dynamic loader**. This ADR decides that slice. MCP is the *out-of-process tool tier* that makes "extend the fleet without a rebuild" true for capabilities, the same way A2A made it true for agents — and trust tiers are the safety boundary that lets us add third-party tools without trusting hand-loaded code.

---

## 1. Context & problem

ADR-0004 §4.7 named four extension tiers; three shipped (A2A agents, in-process DeepAgents, declarative ceremonies). The **capability/tool tier — MCP servers — did not.** Today, giving the fleet a new tool means writing a first-party tool into the agent runtime and redeploying the image. There is no way to say "this agent can now use the filesystem / a web-search / a Postgres MCP server" from the control plane, at runtime, without a rebuild.

Two structural facts:

1. **MCP is the right tool boundary.** The Model Context Protocol is the industry-standard way to expose tools to agents out-of-process (stdio or SSE). workstacean already *serves* an MCP endpoint (`mcp/server.ts`) and the SDK is a dependency (`@modelcontextprotocol/sdk@^1.29.0`). What's missing is the **client** side: connecting *out* to MCP servers and surfacing their tools as fleet executors.

2. **Untrusted code must stay out-of-process.** ADR-0004 §2.3 already decided in-process hot-swap of arbitrary TS is unsafe (Node module cache, stale closures) and partly impossible (workspace bind-mount can't resolve app modules). The `workspace/plugins/*.ts` loader is the broken embodiment of the wrong approach and must be **retired**, not fixed. MCP servers are the correct isolation boundary: a separate process the operator grants specific capabilities.

**Prior scaffolding (harvest, don't trust).** Exploratory P4 code exists uncommitted in the working tree (`src/mcp/`, `src/api/management.ts`). It is partially viable and partially divergent — see §5. We harvest the good parts and discard the rest; greenfield, no parallel surfaces.

---

## 2. Constraints we must honor (from ADR-0004)

1. **The bus is the contract.** MCP mutations are `command.mcp.*` topics → the single `ControlPlaneRegistrar` → atomic file write → hot-reload. No new writer, no cross-plugin calls.
2. **File-backed registry is source of truth.** MCP servers live in `workspace/mcp-servers.yaml` (git-trackable, diffable), never a DB.
3. **One control surface, not two.** MCP CRUD extends the **existing** control-plane API (the `agents-crud.ts` / `/api/a2a-endpoints` / `/api/control-plane/state` pattern shipped in P2/P3/P5). It does **not** introduce a parallel `/api/management/*` namespace.
4. **Read stays unified.** `GET /api/control-plane/state` (P5b) grows an `mcpServers` view; the Console renders it.
5. **Greenfield-strict.** The `workspace/plugins/*.ts` loader is removed, not shimmed.

---

## 3. Decision

**Add an MCP client tier to the fleet control plane: MCP servers are a file-backed, hot-reloaded registry (`workspace/mcp-servers.yaml`), mutated through the existing `command.*` write API + registrar, surfaced in the Console with capability discovery. Each server carries a trust tier that gates auto-enable and an audit record of capability grants. The broken `workspace/plugins/*.ts` loader is retired.**

Resolved forks:

- **D1 — MCP client tier as a registry.** A `McpClientPlugin` reconciles `workspace/mcp-servers.yaml` against the live `ExecutorRegistry`, exactly as `SkillBrokerPlugin` does for A2A: connect to each enabled server, discover its tools, register one `McpExecutor` per (server, tool). Reuses the registrar/hot-reload spine — no new mechanism.
- **D2 — Trust tiers gate AUTO-ENABLE (protoAgent ADR 0001).** `builtin` / `trusted` auto-enable on registration; `community` (the default for anything added via the Console) is **disabled until the operator explicitly flips `enabled: true`**. This is the safety default: a third-party server's tools never go live without a human action.
- **D3 — Capability grants are audit-only in v1.** Grants (`network` / `secrets` / `filesystem`) are recorded in the registry and surfaced in the Console ("what does this server have access to?"). They are **not runtime-enforced in v1** — the MCP server process owns its own isolation. Enforcement (e.g. withholding secret env from a non-`secrets`-granted stdio server we spawn) is a documented follow-up. Rationale: the trust-tier auto-enable gate already prevents untrusted tools from silently activating; grant *enforcement* is additive hardening, not a correctness prerequisite, and shipping the tier without it unblocks the whole capability story now.
- **D4 — Retire the dynamic TS-plugin loader.** Delete the `workspace/plugins/*.ts` `import()` loader from `src/index.ts`. First-party plugins stay compiled-in under `lib/plugins/`. Extension is now exclusively out-of-process (A2A / MCP) or compiled-in.

---

## 4. Architecture

Reuses the ADR-0004 registry spine verbatim:

```
workspace/mcp-servers.yaml ──(file watch, ~5s)──▶ McpClientPlugin.reconcile()
        ▲                                                │ connect → discover tools
        │ atomic write                                   ▼
  ControlPlaneRegistrar ◀── command.mcp.{upsert,remove} ◀── write API (mcp-crud.ts)
                                                          │
                                            ExecutorRegistry.register("mcp:<server>.<tool>", McpExecutor)
```

- **`workspace/mcp-servers.d/<name>.yaml`** — one `McpServerDef` per file (name, trust, transport stdio|sse, command/args/env or url, grants[], allowedTools/excludeTools, enabled, description). Per-file (not a single list) so the `ControlPlaneRegistrar`'s existing atomic per-file `_write`/`_delete(root, msg)` helpers are reused **verbatim** — same shape as `agents.d/` (P3 day-4), honoring "zero new mechanism." There's no hand-maintained base file (all MCP entries are control-plane-managed), so unlike agents there's no `mcp-servers.yaml` companion.
- **`mcp-crud.ts`** — `GET/POST/PUT/DELETE /api/mcp-servers` + `POST /api/mcp-servers/test` (probe), modeled exactly on `agents-crud.ts`. Validates, publishes `command.mcp.{upsert,remove}`, verifies the synchronous registrar write, responds.
- **`ControlPlaneRegistrar`** — gains `command.mcp.*` subscriptions writing to `workspace/mcp-servers.yaml` (path-guarded like the agents roots).
- **`McpClientPlugin`** — on install + on file-watch + on `command.mcp.*`: resolve defaults, skip `enabled: false`, connect via the MCP SDK client (stdio spawns a process; sse connects to a URL), `listTools()`, filter by allow/exclude, register one `McpExecutor` per tool. Unregister + disconnect on removal. Mirrors `SkillBrokerPlugin`'s reconcile shape (ADR-0004 P3 day-4).
- **`McpExecutor implements IExecutor`** — one per (server, tool). `execute()` connects lazily, parses the skill request into tool arguments, calls `client.callTool()`, maps the result to `SkillResult`. `dispose()` closes the client (the ADR-0004 P1 lifecycle hook).
- **Capability discovery** — `POST /api/mcp-servers/test` connects, lists tools, returns reachability + tool list (+ latency), so the Console shows real tools before save. Same test-before-save pattern as `/api/a2a/probe`.
- **Unified read** — `GET /api/control-plane/state` adds `mcpServers: [{ name, trust, enabled, transport, tools[], grants[] }]`.

### Trust + grants

| Trust tier | Auto-enable | Grants | Use |
|---|---|---|---|
| `builtin` | ✅ on registration | implied | ships with the image |
| `trusted` | ✅ on registration | recorded | operator-vetted servers |
| `community` | ❌ `enabled:false` until operator flips it | **required for the operator to consciously approve** | third-party / unknown |

Grants are an **audit + UI** record in v1 (D3). Trust tier is the live gate.

---

## 5. Harvest plan (the uncommitted scaffolding)

| Artifact | Verdict | Why |
|---|---|---|
| `src/mcp/types.ts` | **Keep** | Clean, complete type model (TrustTier, CapabilityGrant, transports, McpServerDef/Config, probe/tool info). Matches this ADR. |
| `src/mcp/mcp-executor.ts` | **Rewrite** | Good shape, but imports a non-existent SDK path (`@modelcontextprotocol/sdk/client/async/client.js`). Reauthor against the real 1.29 client API. |
| `src/mcp/mcp-client-plugin.ts` | **Rewrite** | Same broken imports; re-derive the reconcile loop from the proven `SkillBrokerPlugin` shape rather than the speculative version. |
| `src/api/management.ts` | **Discard** | A parallel `/api/management/*` surface that *duplicates* the `/api/agents`, `/api/a2a-endpoints`, `/api/control-plane/state` routes shipped in P2/P3/P5. Two surfaces violates ADR-0004 §2.3. Fold only the MCP-specific routes into `mcp-crud.ts` on the established pattern. |

---

## 6. Phased plan (one green, tested, shippable PR per slice)

| Day | Goal | Deliverable | Acceptance |
|---|---|---|---|
| **1** | This ADR slice + plan | `docs/decisions/0005-*.md`; harvest decisions; trust/grant model | Direction agreed; phasing pinned. |
| **2** | MCP registry (no live connection) | Harvest `types.ts`; `workspace/mcp-servers.yaml`; `mcp-crud.ts` write API; `command.mcp.*` → registrar; `mcpServers` in `/api/control-plane/state`. | Add/remove an MCP server via API → persisted to YAML → appears in the unified read; auth-gated; tests. |
| **3** | MCP client tier (live) | `McpClientPlugin` + `McpExecutor` (stdio + sse) against the real SDK; reconcile on `command.mcp.*`/watch; `POST /api/mcp-servers/test` capability discovery. | Register an enabled server → its tools register as executors live, no restart; probe returns real tools; remove → unregister + disconnect; tests. |
| **4** | Trust tiers + grants + Console | Trust-tier auto-enable gate; audit-only grants; Console MCP pane (add / probe / grant checkboxes / trust badge / enable toggle / remove). | `community` server stays inert until enabled; grants visible; Console drives the full lifecycle; branded. |
| **5** | Retire TS-plugin loader + wrap | Delete `workspace/plugins/*.ts` loader from `src/index.ts` (greenfield); update `flow-dashboard.md` / extension docs; ADR-0004 §4.7 + epic; retro. | Loader gone, no shim; docs name MCP as the tool tier; tests green; **P4 complete**, ADR-0004 epic fully closed. |

---

## 7. Consequences

**Positive**
- The capability/tool tier is finally hot-swappable from the control plane — the last of ADR-0004 §4.7's four tiers.
- Trust tiers make adding third-party tools safe-by-default (off until approved), without trusting hand-loaded code.
- The broken dynamic-plugin loader is gone — one fewer footgun, one honest extension story (out-of-process or compiled-in).
- Zero new mechanism: MCP rides the exact registry/registrar/hot-reload/unified-read spine ADR-0004 already proved.

**Costs / risks**
- stdio MCP servers spawn child processes — lifecycle (spawn/dispose), env injection, and zombie-avoidance need the same drain-before-dispose care as executors (ADR-0004 P1).
- Grant *enforcement* is deferred (D3) — documented as audit-only; the trust gate carries the safety load in v1.
- The MCP SDK is a moving dependency; pin and wrap the client behind `McpExecutor` so a SDK change is one file.

---

## 8. Alternatives considered

- **In-process tool plugins (fix the `workspace/plugins/*.ts` loader).** Rejected — ADR-0004 §2.3 / §8 already settled this; Node module cache + module-resolution wall make it unsafe and partly impossible. MCP is the correct out-of-process boundary.
- **A parallel `/api/management/*` API (the scaffolding's shape).** Rejected — duplicates the shipped control-plane routes; two surfaces drift. Fold into the established pattern.
- **Enforce capability grants at runtime in v1.** Deferred, not rejected — the trust-tier auto-enable gate already prevents silent activation; enforcement is additive hardening (withhold secret env from non-granted stdio servers, etc.) and shouldn't block the tier from shipping.
- **A config DB for MCP servers.** Rejected — YAML-in-workspace stays the source of truth, consistent with agents/ceremonies/channels.

---

## 9. Related

- [ADR-0004 — Fleet Control Plane](./0004-fleet-control-plane-and-hot-swappable-extension) — the parent; this is its P4 slice. Epic #707, this slice #712.
- protoAgent **ADR 0001** — the tiers / manifests / capability-grants / trust-tiers reference being generalized into the fleet host.
- Code anchors: `src/mcp/types.ts` (harvest), `src/plugins/skill-broker-plugin.ts` (the A2A reconcile shape to mirror), `src/plugins/control-plane-registrar-plugin.ts` (extend with `command.mcp.*`), `src/api/agents-crud.ts` (the CRUD template), `src/api/control-plane.ts` (the unified read to extend), `src/index.ts` (the `workspace/plugins/*.ts` loader to delete), `mcp/server.ts` (the existing MCP *server* side, for SDK-version reference).

# A2A fleet census (2026-06-01) — who speaks A2A, on what

Grounds the flag-day cutover to A2A 1.0. **Key surprise: only the hub uses an SDK.**

| Repo | Lang | A2A impl | Server | Client | Custom extensions | Live? |
|---|---|---|---|---|---|---|
| **protoWorkstacean** | TS | `@a2a-js/sdk` 0.3.13 | ✅ | ✅ | consumes worldstate-delta/cost-v1/confidence-v1 | LIVE (hub) |
| **protoAgent** | Python | hand-rolled (~2059 LOC) | ✅ | ✅ | + tool-call-v1 (emits all) | LIVE |
| **ORBIS** | Python | hand-rolled (server.py + client.py) | ✅ | ✅ | none declared | LIVE |
| **pwnDeck** | Python | hand-rolled (~925 LOC) | ✅ | ❌ | none | LIVE |
| **quinn** (repo) | Python | hand-rolled (~1545 LOC) | ✅ | ✅ | ? | ⚠️ likely DEAD — standalone Quinn absorbed in-process (ws #529); confirm before touching |
| **protoResearcher** | Python | hand-rolled (inline ~50 LOC) | ✅ | ❌ | none | ⚠️ likely DEAD — retired/dormant; confirm |

## What this means for the migration

- **The SDK 1.0 bump only touches protoWorkstacean** — the spike (~5 source files, 78 errors). Everywhere else is hand-rolled.
- **An official Python A2A SDK exists** — `a2a-sdk` (a2aproject, stable 1.0/1.1, 0.3-compat mode). The census originally read "no Python SDK" because the six Python handlers *don't use one* — they hand-roll the 0.3 JSON-RPC / SSE / card / Part shapes. **Corrected direction (ADR-0006): adopt `a2a-sdk` + the `protolabs-a2a` conventions layer and DELETE the hand-rolled handlers** — not hand-edit them to 1.0. (protoAgent#453 proved this; the migration is a dependency adoption, not a wire-shape hand-edit.)
- **The custom extensions are already a half-formal contract**: the Python handlers declare extension URIs (`https://proto-labs.ai/a2a/ext/cost-v1`, etc.) in their agent-card capabilities. workstacean *consumes* them but doesn't *declare* them. 1.0 work = formalize them as declared `AgentExtension`s on the hub too, and keep the contract byte-stable across the version bump.
- **Reference-implementation pattern is the lever:** the SDK gives workstacean 1.0 conformance "for free"; the hand-rolled Python repos have to match the wire by hand. So **workstacean's SDK-driven output becomes the canonical reference** the Python handlers conform to. ADR-0006 must spell out the exact 1.0 wire contract for the hand-rolled side.

## Live cutover set (flag day)

protoWorkstacean (hub) + protoAgent + ORBIS + pwnDeck. `quinn` + `protoResearcher` repos appear dead — **confirm liveness before including/excluding** them.

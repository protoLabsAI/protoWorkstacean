---
title: "Extension: x-protolabs/effect-domain-v1"
---

`x-protolabs/effect-domain-v1` is an A2A extension implemented as an **after-hook interceptor** ([`src/executor/extensions/effect-domain.ts`](../../src/executor/extensions/effect-domain.ts)). It does two things around every skill execution:

1. **`before`** — stamps the current skill name onto outbound request metadata as `x-effect-domain-skill`, so the agent knows which skill is being invoked and can report the deltas it observed.
2. **`after`** — reads any `worldstate-delta` artifact the agent returned in its terminal Task and re-publishes the observed mutations on the `world.state.delta` bus topic for downstream observability.

There is no planner. This extension is purely a reporting/observability hook: it surfaces *agent-reported* state mutations onto the bus. The consumer is [`task-tracker.ts`](../../src/executor/task-tracker.ts), which de-dupes per task and emits the same `world.state.delta` events for fleet observability and health.

**Extension URI**: `https://proto-labs.ai/a2a/ext/effect-domain-v1`

---

## Purpose

When an agent applies a change to some shared state (closes a PR, triages an issue), it can report that mutation as a `worldstate-delta` artifact part on its terminal A2A Task. The effect-domain after-hook lifts those reported deltas onto the bus as `world.state.delta` events so the dashboard and fleet-health tooling can observe them in near-real-time rather than waiting for the next full poll.

The deltas are **observed, agent-reported facts** — not predictions consumed by any scheduler or selector.

---

## Wiring

Call `registerEffectDomainExtension(bus)` once at startup (in `src/index.ts`) with a live `EventBus`. This registers the interceptor with `defaultExtensionRegistry`. The `after` hook needs the bus reference to publish `world.state.delta`.

---

## worldstate-delta artifact

Agents report mutations via a structured `data` artifact part on their terminal Task, using MIME type `application/vnd.protolabs.worldstate-delta+json` (defined in [`packages/a2a/src/extensions.ts`](../../packages/a2a/src/extensions.ts)). The discriminator rides on the part's `metadata.mimeType`; the payload is in `content.value`. Each entry:

| Field | Type | Description |
|-------|------|-------------|
| `domain` | `string` | Name of the world-state domain (e.g. `ci`, `github_issues`) |
| `path` | `string` | Dot-separated path into the domain's data object (e.g. `data.blockedPRs`) |
| `op` | `"set" \| "inc" \| "push"` | Mutation operation: replace, add-to, or append |
| `value` | `unknown` | Value to set, increment by, or append (must be a number for `inc`) |

Example artifact `data` payload:

```json
{
  "deltas": [
    { "domain": "ci", "path": "data.blockedPRs", "op": "inc", "value": -1 },
    { "domain": "board", "path": "data.untriaged", "op": "inc", "value": -1 }
  ]
}
```

---

## Published event

After a skill execution whose terminal artifact carried a `worldstate-delta` part, the interceptor publishes on `world.state.delta`:

```ts
{
  source: string;   // agent that produced the delta
  skill: string;    // skill that was executed
  deltas: WorldStateDeltaEntry[];
}
```

`task-tracker.ts` subscribes to the A2A response path, extracts the same delta parts, and emits `world.state.delta` idempotently per task — the canonical consumer for observability and fleet health.

---

## Versioning

This is version 1 of the effect-domain extension. The URI `https://proto-labs.ai/a2a/ext/effect-domain-v1` is stable. Breaking changes will be published under a new versioned URI.

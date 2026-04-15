---
title: Extend an A2A Agent — the x-protolabs extensions pack
---

Once you've built the A2A spec surface ([Build an A2A Agent](./build-an-a2a-agent.md)) your agent works as a plain A2A responder — workstacean discovers skills, dispatches, tracks tasks, reports to fleet health. But five additional capabilities let the dispatcher, planner, and HITL policy make smarter decisions about each skill:

| Extension | Purpose | Direction |
|---|---|---|
| [cost-v1](../extensions/cost-v1.md) | Token + wall-time observations → planner tiebreaker | workstacean → stores → planner |
| [confidence-v1](../extensions/confidence-v1.md) | Agent self-reported confidence → calibration + ranking | your agent → stores → planner |
| [effect-domain-v1](../extensions/effect-domain-v1.md) | Declared world-state deltas → faster planner convergence | your agent's card + response artifacts |
| [blast-v1](../extensions/blast-v1.md) | Scope-of-effect declaration → HITL/policy routing | your agent's card |
| [hitl-mode-v1](../extensions/hitl-mode-v1.md) | Per-skill approval policy → HITL flow selection | your agent's card |

You don't have to implement any of them. You keep working as a plain A2A agent. But each extension unlocks behavior on the workstacean side that only fires when you opt in.

## How workstacean picks them up

All five interceptors are **registered unconditionally** at workstacean startup (`src/index.ts`). They run on every outbound A2A call, but **self-gate** on whether you advertised the URI in your agent card. Workstacean never forces behavior on agents that don't opt in.

Two concrete consequences:

1. **Card-only extensions** (blast-v1, hitl-mode-v1, effect-domain-v1's declarations): the `before` hook reads `defaultXxxRegistry` — populated when `SkillBrokerPlugin` refreshes your card every 10 min. If you don't declare, the registry miss is a no-op; nothing is stamped on the outbound request.
2. **Observation extensions** (cost-v1, confidence-v1): the `after` hook reads the response's `data` field. If your agent doesn't include `usage` / `confidence` fields, the interceptor early-returns without recording.

This means extensions are a **zero-risk gradient**. Ship your agent, observe fleet health, decide one extension at a time whether it's worth declaring.

## A complete example — Quinn's card

Here's what it looks like when an agent opts in to all five:

```json
{
  "name": "quinn",
  "description": "QA engineer — PR review, bug triage, board audit",
  "url": "http://quinn:7870/a2a",
  "version": "1.0.0",
  "provider": { "organization": "protoLabsAI" },
  "capabilities": {
    "streaming": true,
    "pushNotifications": true,
    "stateTransitionHistory": false,
    "extensions": [
      { "uri": "https://protolabs.ai/a2a/ext/cost-v1" },
      { "uri": "https://protolabs.ai/a2a/ext/confidence-v1" },

      {
        "uri": "https://protolabs.ai/a2a/ext/effect-domain-v1",
        "params": {
          "skills": {
            "pr_review":     { "effects": [{ "domain": "pr_pipeline", "path": "data.conflicting", "delta": -1, "confidence": 0.7 }] },
            "bug_triage":    { "effects": [{ "domain": "board", "path": "data.openBugs",   "delta": -1, "confidence": 0.8 }] },
            "board_audit":   { "effects": [] }
          }
        }
      },

      {
        "uri": "https://protolabs.ai/a2a/ext/blast-v1",
        "params": {
          "skills": {
            "sitrep":          { "radius": "self" },
            "board_audit":     { "radius": "project" },
            "pr_review":       { "radius": "repo" },
            "bug_triage":      { "radius": "project" },
            "security_triage": { "radius": "fleet",  "note": "Can affect the entire fleet's security posture" }
          }
        }
      },

      {
        "uri": "https://protolabs.ai/a2a/ext/hitl-mode-v1",
        "params": {
          "skills": {
            "sitrep":          { "mode": "autonomous" },
            "board_audit":     { "mode": "notification" },
            "pr_review":       { "mode": "veto", "vetoTtlMs": 300000 },
            "bug_triage":      { "mode": "notification" },
            "security_triage": { "mode": "gated", "reviewer": "operator" }
          }
        }
      }
    ]
  },

  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/markdown"],
  "skills": [
    { "id": "sitrep",          "name": "Situation Report",  "description": "…" },
    { "id": "board_audit",     "name": "Board Audit",       "description": "…" },
    { "id": "pr_review",       "name": "PR Review",         "description": "…" },
    { "id": "bug_triage",      "name": "Bug Triage",        "description": "…" },
    { "id": "security_triage", "name": "Security Triage",   "description": "…" }
  ],
  "securitySchemes": {
    "apiKey": { "type": "apiKey", "in": "header", "name": "X-API-Key" }
  },
  "security": [{ "apiKey": [] }]
}
```

Notice:

- cost-v1 + confidence-v1 have **no params** — declaring the URI is enough to opt in. Your agent still has to include `usage` / `confidence` fields on terminal-task `data` for samples to be recorded.
- effect-domain-v1, blast-v1, hitl-mode-v1 carry `params.skills` — a map keyed by skill id.
- You don't declare every skill. Only the ones where the default (no declaration → no-op) isn't what you want.

## Response-side requirements

For the **observation extensions** (cost-v1, confidence-v1), you also need to include the expected fields on your terminal `Task.data`. None of these are required by the A2A spec itself — they're extension-specific conventions:

```json
{
  "status": { "state": "completed" },
  "artifacts": [{ "parts": [{ "kind": "text", "text": "…" }] }],
  "data": {
    "usage": {
      "input_tokens": 3421,
      "output_tokens": 890,
      "cache_read_input_tokens": 0
    },
    "durationMs": 4823,
    "costUsd": 0.0187,
    "confidence": 0.88,
    "confidenceExplanation": "Spec was unambiguous; all tests pass.",
    "success": true
  }
}
```

- `usage.input_tokens` / `output_tokens` — Anthropic-shaped token counts. Cached tokens are optional but tracked when provided.
- `durationMs` / `costUsd` — wall-time + dollar cost. `costUsd` is optional; the cost-v1 consumer can compute from tokens + `MODEL_RATES` if missing.
- `confidence` — float in `[0, 1]`. Required for confidence-v1 sample recording; the extension defensively clamps out-of-range values.
- `confidenceExplanation` — free-text, surfaced in calibration views.
- `success` — `false` explicitly marks a failure even when `state: completed`. Use this when your skill returns a textual failure message rather than throwing.

For **effect-domain-v1** (the response side of it), attach a `worldstate-delta` DataPart to your terminal task's artifacts when you've mutated shared state:

```json
{
  "artifacts": [
    {
      "parts": [
        { "kind": "text", "text": "Closed 3 stale PRs" },
        {
          "kind": "data",
          "data": {
            "deltas": [
              { "domain": "pr_pipeline", "path": "data.staleOpen", "op": "inc", "value": -3 }
            ]
          },
          "metadata": { "mimeType": "application/vnd.protolabs.worldstate-delta+json" }
        }
      ]
    }
  ]
}
```

Workstacean's effect-domain-v1 after-hook extracts this and publishes `world.state.delta` — the planner picks up the mutation immediately instead of waiting for the next full domain poll.

## Registration at workstacean side

For reference — you don't need to do anything here; this is what workstacean runs at startup:

```ts
// src/index.ts
registerCostExtension(bus);
registerConfidenceExtension(bus);
registerEffectDomainExtension(bus);
registerBlastExtension();
registerHitlModeExtension();
```

All five interceptors live in `defaultExtensionRegistry` and fire on every `A2AExecutor.execute()` call. Self-gating keeps them safe for non-opt-in agents.

## Adoption order — recommended

1. **cost-v1** — zero card changes, just emit `usage` + `durationMs` in your terminal data. Gets you dashboard visibility + planner ranking for your agent.
2. **confidence-v1** — add `confidence` to your terminal data. Gets your agent into calibration views and unblocks the "high-confidence failure" signal for OutcomeAnalysis.
3. **blast-v1** — declare scope per skill on the card. Unlocks policy-driven HITL gating without code changes.
4. **hitl-mode-v1** — declare per-skill approval policy. Now your skills route through the right HITL flow by default (autonomous / notification / veto / gated / compound).
5. **effect-domain-v1** — the most involved: declare expected deltas on the card, include observed deltas in your response artifacts. Lets the planner react to your actions in ~1s instead of one poll cycle.

Each step is independently useful. The pack composes — e.g. blast-v1 + hitl-mode-v1 together let you say "anything `fleet` or `public` radius is `gated`, reviewer: operator."

## Related

- [Build an A2A Agent](./build-an-a2a-agent.md) — the spec-side recipe (task store, webhooks, health)
- [Self-improving loop](../explanation/self-improving-loop.md) — how extension observations feed the planner + goal proposals
- Extension reference pages — [cost-v1](../extensions/cost-v1.md), [confidence-v1](../extensions/confidence-v1.md), [effect-domain-v1](../extensions/effect-domain-v1.md), [blast-v1](../extensions/blast-v1.md), [hitl-mode-v1](../extensions/hitl-mode-v1.md)

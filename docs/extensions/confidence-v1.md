---
title: "Extension: x-protolabs/confidence-v1"
---

`x-protolabs/confidence-v1` is an A2A agent card extension that lets an agent attach a self-reported confidence score to its terminal message. OutcomeAnalysisPlugin uses these scores to weight failure signals — a high-confidence bad outcome is a stronger quality signal than a low-confidence one where the agent itself was uncertain.

**Extension URI**: `https://protolabs.ai/a2a/ext/confidence-v1`

---

## Purpose

Without confidence scores, OutcomeAnalysis treats every failure equally: each missed action counts as one failure regardless of how certain the agent was about its own outcome. This is noisy — an agent that says "I'm 10% confident this worked" failing is much less alarming than one that says "I'm 95% confident" and still failing.

When an agent attaches a confidence score to its terminal message, OutcomeAnalysis can:

- Weight each failure by the agent's reported confidence
- Surface high-confidence chronic failures sooner (less evidence needed)
- Avoid false alerts from fundamentally uncertain or exploratory skills
- Include confidence metadata in the `ops.alert.action_quality` payload for diagnostics

---

## Schema

The agent includes an `x-confidence` block in the `data` field of its terminal A2A task artifact:

```json
{
  "x-confidence": {
    "confidence": 0.72,
    "explanation": "Three of the five test cases passed; the remaining two require manual review."
  }
}
```

### Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `confidence` | `number` | yes | Self-reported confidence in the outcome, in `[0.0, 1.0]`. `1.0` = fully certain, `0.0` = no confidence |
| `explanation` | `string` | no | Human-readable reason for the reported confidence score |

---

## How the extension works

When an agent card declares the `confidence-v1` extension, the A2A executor applies the registered interceptor after each skill execution:

1. **`after` hook** — reads `result.data["x-confidence"]` from the terminal artifact
2. Publishes `world.action.confidence` to the bus with `{ correlationId, agentName, skill, confidence, explanation }`
3. **OutcomeAnalysisPlugin** subscribes to `world.action.confidence`, caches confidence by `correlationId`
4. When `world.action.outcome` arrives for the same correlationId, the plugin weights the failure score: `weightedFailure += confidence`
5. Alert threshold checks `success / (success + weightedFailure + timeout)` — a few high-confidence failures can trigger the alert even when raw counts look borderline

Agents that do not declare this extension continue to work normally; missing confidence defaults to `1.0` (full weight) so existing failure tracking is unchanged.

---

## Registering the extension (agent card)

Add the extension URI to the agent's `/.well-known/agent-card.json`:

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://protolabs.ai/a2a/ext/confidence-v1"
      }
    ]
  }
}
```

No `params` are needed — the extension has no static configuration on the card side. The confidence value is returned dynamically in each terminal message.

---

## In-process agents (workspace/agents/\<name\>.yaml)

In-process agents built on `@protolabsai/sdk` can return confidence by including `x-confidence` in their tool result's structured data:

```typescript
return {
  text: "PR review complete — 3 comments left, approval withheld pending CI.",
  data: {
    "x-confidence": {
      confidence: 0.85,
      explanation: "CI results were deterministic; approval decision is certain."
    }
  }
};
```

---

## Example: confidence-weighted alert

Scenario: `pr_review` action runs 10 times. Six succeed. Four fail — but all four failures have `confidence: 0.9`.

| Metric | Value |
|--------|-------|
| total | 10 |
| success | 6 |
| failure | 4 |
| weightedFailure | 3.6 (4 × 0.9) |
| successRate | 0.60 (60%) |
| weightedSuccessRate | 6 / (6 + 3.6) ≈ 0.625 |

The weighted success rate (0.625) is above the `POOR_SUCCESS_THRESHOLD` (0.5), so no alert fires. However, if the same four failures had `confidence: 1.0`, `weightedSuccessRate` = 6 / (6 + 4) = 0.60 — still above threshold. The key effect: **low-confidence failures are discounted**, reducing false alerts for inherently uncertain skills while preserving sensitivity for confident ones.

---

## Bus events

### `world.action.confidence` (published by extension)

```typescript
interface ActionConfidencePayload {
  correlationId: string;  // Links to the corresponding world.action.outcome
  agentName: string;      // Agent that reported this confidence
  skill: string;          // Skill that was executed
  confidence: number;     // [0.0, 1.0]
  explanation?: string;   // Optional rationale
}
```

---

## Versioning

This is version 1 of the confidence extension. The URI `https://protolabs.ai/a2a/ext/confidence-v1` is stable. Changes to the confidence interpretation semantics or schema will be published under a new versioned URI.

---
title: "Extension: x-protolabs/confidence-v1"
---

`x-protolabs/confidence-v1` is an A2A agent card extension that lets agents attach a confidence score to their terminal message. `OutcomeAnalysisPlugin` uses these scores to weight failure signals — a high-confidence bad outcome contributes more to chronic-failure detection than a low-confidence one.

**Extension URI**: `https://protolabs.ai/a2a/ext/x-protolabs/confidence-v1`

---

## Purpose

Without confidence scores, all failures are treated equally by the learning loop. An agent that was 90% confident it would succeed but failed is a stronger signal than one that was 20% confident. Weighting failures by the agent's stated confidence makes `OutcomeAnalysisPlugin` more accurate:

- High-confidence failures drive faster alerts for chronic issues
- Low-confidence failures (exploratory or uncertain actions) are discounted proportionally
- The overall system learns to distinguish "this action is broken" from "this action is hard"

---

## Schema

Declared inside the A2A agent card under `capabilities.extensions`:

```yaml
capabilities:
  extensions:
    - uri: https://protolabs.ai/a2a/ext/x-protolabs/confidence-v1
```

No extension params are needed — the confidence value is carried in the terminal message artifact, not the agent card.

### Terminal artifact data

Agents return confidence in the structured data of their terminal message:

```json
{
  "x-protolabs-confidence": {
    "confidence": 0.72,
    "explanation": "Merged two of three reviewers but one still pending"
  }
}
```

### Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `confidence` | `number` | yes | Agent's confidence that the task succeeded, in the range `[0.0, 1.0]` |
| `explanation` | `string` | no | Human-readable justification for the confidence value |

---

## How OutcomeAnalysis uses confidence

When `x-protolabs/confidence-v1` is present, the interceptor publishes `world.action.confidence` after each skill execution. `OutcomeAnalysisPlugin` subscribes and tracks a `weightedFailure` accumulator per action:

```
weightedFailure += confidence   (for each failure event)
```

The adjusted success rate used for alert evaluation becomes:

```
adjustedRate = success / (success + weightedFailure + timeout)
```

A failure reported with `confidence: 1.0` contributes `1.0` to the denominator; one with `confidence: 0.2` contributes only `0.2`. Successes and timeouts are unweighted.

---

## Example

An agent executing `pr_review` returns:

```json
{
  "text": "Review submitted with REQUEST_CHANGES",
  "data": {
    "x-protolabs-confidence": {
      "confidence": 0.85,
      "explanation": "CI was green and diff was within scope, but one nit left unresolved"
    }
  }
}
```

If the action is then recorded as failed (e.g. the PR was reverted), that failure contributes `0.85` to `weightedFailure` rather than the flat `1` of an unweighted failure.

---

## Registering the extension

### In-process agent (workspace/agents/\<name\>.yaml)

```yaml
capabilities:
  extensions:
    - uri: https://protolabs.ai/a2a/ext/x-protolabs/confidence-v1
```

### External A2A agent (agent card)

```json
{
  "capabilities": {
    "extensions": [
      { "uri": "https://protolabs.ai/a2a/ext/x-protolabs/confidence-v1" }
    ]
  }
}
```

Call `registerConfidenceExtension(bus)` once at startup to wire the interceptor into `defaultExtensionRegistry`.

---

## Versioning

This is version 1 of the confidence extension. The URI `https://protolabs.ai/a2a/ext/x-protolabs/confidence-v1` is stable. Breaking changes will be published under a new versioned URI.

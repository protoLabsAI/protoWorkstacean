---
title: "Extension: x-protolabseffect-domain-v1"
---

`x-protolabseffect-domain-v1` is an A2A agent card extension that lets skills declare their expected world-state mutations. The L1 planner reads these declarations to score and select candidate skills when building a plan.

**Extension URI**: `https://protolabs.ai/a2a/ext/effect-domain-v1`

---

## Purpose

Without effect declarations, the planner treats skills as black boxes and must fall back to LLM reasoning (L2) to estimate which skill is most likely to move world state toward a goal. When a skill declares its effects, the L1 planner can:

- Rank candidates by expected delta relative to the active goal
- Detect conflicts (two skills writing the same path with opposing deltas)
- Prefer high-confidence declarations over uncertain ones
- Skip skills whose declared effects are irrelevant to the current goal

---

## Schema

Declared inside the A2A agent card under `capabilities.extensions`:

```yaml
capabilities:
  extensions:
    - uri: https://protolabs.ai/a2a/ext/effect-domain-v1
      params:
        skills:
          <skill_name>:
            effects:
              - domain: <domain>
                path: <dot-separated path into domain data>
                delta: <numeric change>
                confidence: <0.0–1.0>
```

### Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `string` | yes | Name of the world-state domain as declared in `workspace/domains.yaml` |
| `path` | `string` | yes | Dot-separated path into the domain's `data` object (e.g. `data.blockedPRs`) |
| `delta` | `number` | yes | Expected signed change to the value at `path` after successful skill execution (negative = decrease, positive = increase) |
| `confidence` | `number` | yes | Planner weight for this effect declaration, in the range `[0.0, 1.0]`. Use `1.0` for deterministic effects and lower values for probabilistic ones |

A skill may declare multiple effects if it mutates more than one path.

---

## Example

```yaml
capabilities:
  extensions:
    - uri: https://protolabs.ai/a2a/ext/effect-domain-v1
      params:
        skills:
          pr_review:
            effects:
              - domain: ci
                path: data.blockedPRs
                delta: -1
                confidence: 0.8
          bug_triage:
            effects:
              - domain: plane
                path: data.untriaged
                delta: -1
                confidence: 0.9
              - domain: plane
                path: data.inProgress
                delta: 1
                confidence: 0.9
```

In this example, running `pr_review` is expected to reduce `ci.data.blockedPRs` by 1 with 80% confidence. Running `bug_triage` is expected to move one item from untriaged to in-progress with 90% confidence.

---

## How the planner uses effect declarations

1. **Goal matching** — when a goal targets a world-state selector (e.g. `ci.blockedPRs` must reach `0`), the planner identifies all skills whose declared effects include a matching `domain` + `path`.
2. **Candidate scoring** — candidates are scored by `|delta| × confidence`. Higher-scoring candidates are expanded first in the A* search.
3. **Plan construction** — each selected skill becomes an action edge in the action graph. The expected post-execution state is computed by applying the declared deltas to the current world state snapshot.
4. **Conflict detection** — two skills writing the same path with opposing deltas in the same plan raise a planning warning and the lower-confidence skill is dropped.

Effect declarations are advisory — the planner still validates the actual world state after each skill executes and replans if the observed outcome diverges from the declared delta.

---

## Registering the extension

### In-process agent (workspace/agents/\<name\>.yaml)

In-process agent YAML does not use the full A2A agent card format. Declare effects inline under the skill entry:

```yaml
skills:
  - name: pr_review
    description: Review PRs and submit formal APPROVE/REQUEST_CHANGES
    effects:
      - domain: ci
        path: data.blockedPRs
        delta: -1
        confidence: 0.8
```

### External A2A agent (agent card)

Add the extension to the agent's `/.well-known/agent-card.json`:

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://protolabs.ai/a2a/ext/effect-domain-v1",
        "params": {
          "skills": {
            "pr_review": {
              "effects": [
                { "domain": "ci", "path": "data.blockedPRs", "delta": -1, "confidence": 0.8 }
              ]
            }
          }
        }
      }
    ]
  }
}
```

`SkillBrokerPlugin` reads extensions from the agent card during discovery and merges them into the executor registry.

---

## Versioning

This is version 1 of the effect-domain extension. The URI `https://protolabs.ai/a2a/ext/effect-domain-v1` is stable. Breaking changes (field renames, semantic changes to `confidence` interpretation) will be published under a new versioned URI.

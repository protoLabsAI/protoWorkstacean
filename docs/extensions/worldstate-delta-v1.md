---
title: "Artifact: x-protolabs/worldstate-delta-v1"
---

`x-protolabs/worldstate-delta-v1` defines the artifact format agents use to report observed world-state mutations when a skill execution changes shared state. The effect-domain interceptor reads these artifacts from the terminal Task and publishes a `world.state.delta` bus event so the GOAP planner can update its world-state snapshot without waiting for the next full poll cycle.

**MIME type**: `application/vnd.protolabs.worldstate-delta+json`

---

## Purpose

When an agent executes a skill that mutates shared state (e.g. merges a PR, closes a ticket, updates a config), it can report those mutations by attaching a `worldstate-delta` artifact part to its terminal Task. This gives the planner an immediate, ground-truth signal rather than inferring state from declared effects alone.

The flow:

1. Agent executes a skill and observes the actual state changes it made
2. Agent includes a `worldstate-delta` artifact part in its terminal Task response
3. The effect-domain interceptor in the executor layer extracts the part
4. Interceptor publishes `world.state.delta` on the event bus
5. GOAP planner applies the deltas to its cached world-state snapshot

---

## Artifact part shape

The artifact must be a `DataPart` (A2A `kind: "data"`) with the MIME type stored in `metadata.mimeType`:

```json
{
  "kind": "data",
  "data": {
    "deltas": [
      {
        "domain": "ci",
        "path": "data.blockedPRs",
        "op": "inc",
        "value": -1
      }
    ]
  },
  "metadata": {
    "mimeType": "application/vnd.protolabs.worldstate-delta+json"
  }
}
```

The part may appear alongside text parts in the same artifact, or as a standalone artifact.

---

## Schema

### `WorldStateDeltaArtifactData`

The `data` field of the artifact part:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deltas` | `WorldStateDeltaEntry[]` | yes | One or more mutations to apply |

### `WorldStateDeltaEntry`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | `string` | yes | World-state domain name (e.g. `"ci"`, `"plane"`) |
| `path` | `string` | yes | Dot-separated path into the domain's `data` object (e.g. `"data.blockedPRs"`) |
| `op` | `"set" \| "inc" \| "push"` | yes | Mutation operation (see below) |
| `value` | `unknown` | yes | Value to apply. Must be a number for `"inc"`. |

### Operations

| Op | Semantics |
|----|-----------|
| `"set"` | Replace the current value at `path` with `value` (idempotent) |
| `"inc"` | Add `value` (a number) to the current numeric value at `path` |
| `"push"` | Append `value` to the array at `path` |

---

## Examples

### Close one ticket and move it to in-progress

```json
{
  "deltas": [
    { "domain": "plane", "path": "data.untriaged", "op": "inc", "value": -1 },
    { "domain": "plane", "path": "data.inProgress", "op": "inc", "value": 1 }
  ]
}
```

### Record completed PR merge

```json
{
  "deltas": [
    { "domain": "ci", "path": "data.blockedPRs", "op": "inc", "value": -1 },
    { "domain": "ci", "path": "data.mergedToday", "op": "inc", "value": 1 }
  ]
}
```

### Set a configuration value

```json
{
  "deltas": [
    { "domain": "config", "path": "data.featureFlags.newUI", "op": "set", "value": true }
  ]
}
```

---

## Relation to declared effects

| | Effect-domain declarations | Worldstate-delta artifact |
|-|---------------------------|--------------------------|
| **When** | At agent card registration time | At skill execution time (terminal Task) |
| **Purpose** | Planner scoring and candidate ranking | Ground-truth update to cached world state |
| **Format** | `{ delta: number, confidence: number }` | `{ op, value }` |
| **Consumer** | L1 planner (A* scoring) | Effect-domain interceptor → `world.state.delta` bus |

Declarations are advisory. Deltas are observed fact.

---

## Versioning

This is version 1 of the worldstate-delta artifact format. The MIME type `application/vnd.protolabs.worldstate-delta+json` is stable. Breaking changes (new required fields, semantic changes to operations) will be published under a new versioned MIME type suffix (e.g. `…+json;v=2`).

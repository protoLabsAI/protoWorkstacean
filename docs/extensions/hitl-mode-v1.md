---
title: "Extension: x-protolabs/hitl-mode-v1"
---

`x-protolabs/hitl-mode-v1` lets agents declare the **approval policy** for each skill on their agent card. HITL is a gradient, not a binary — this extension lets the dispatcher + HITL plugin route each skill invocation through the right flow without goal-level config.

**Extension URI**: `https://proto-labs.ai/a2a/ext/hitl-mode-v1`

---

## The five modes

Ordered from least-gated to most-gated:

| Mode | Semantics |
|---|---|
| `autonomous` | No human in the loop. Task runs, outcome is what it is. |
| `notification` | Runs autonomously. A read-only notification is rendered on the originating surface (Discord, Plane) for awareness. |
| `veto` | Short TTL window after dispatch where a human can cancel via `tasks/cancel` before side effects complete. Auto-approved on TTL expiry. |
| `gated` | Blocking `input-required` **before** any side effect. No auto-approve; execution halts until a decision. |
| `compound` | Multi-checkpoint gated. The agent emits multiple `input-required` states across the task lifecycle (draft → review → publish); each requires its own decision. |

`HITL_MODE_ORDER` ranks them `autonomous=0` through `compound=4` for numeric comparisons.

---

## Reviewer resolution — sub-agent → caller

**This is the part agent-authors most often get wrong.** HITL doesn't always mean "human in the loop" — it can mean "dispatching agent in the loop."

Picture the chain: Ava dispatches `pr_review` to Quinn. Quinn needs the user's intent clarified on an ambiguous change. The `input-required` state should route back to **Ava** (the dispatcher), not straight to the human operator. Ava then chooses:

1. Answer autonomously from context she already has, or
2. Bubble up to the human if she genuinely needs their input

The reviewer precedence is:

```
input-required
  → dispatching agent (if present; agent-scoped resolution)
  → renderer chain (Discord, Plane, etc.) as final fallback
```

`TaskTracker` reads the original dispatch's `source.agentId` to decide the first hop. Sub-agent chains (Ava → Quinn → protoMaker) walk the chain back until a resolver wants the question or the chain terminates at the operator.

A declaration can override this via `reviewer`:

```json
{ "mode": "gated", "reviewer": "operator" }
```

Forces the prompt straight to the human for skills where the dispatching agent's judgment isn't sufficient (e.g. production deploys). Default without this field is the caller-first chain.

---

## What the extension does

A **read-side** declaration — hitl-mode-v1 does NOT mutate outbound traffic or collect observations. It's policy metadata.

- **`before(ctx)`** — stamps `x-hitl-mode: <mode>` (and `x-hitl-veto-ttl-ms: <N>` if set) on outbound metadata. Downstream consumers read these to decide how to render the prompt.
- **`after(ctx)`** — no-op. Mode is policy, not observation.

Registration at startup in `src/index.ts`:

```ts
import { registerHitlModeExtension } from "./executor/extensions/hitl-mode.ts";
registerHitlModeExtension();
```

---

## Declaring it on your agent card

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://proto-labs.ai/a2a/ext/hitl-mode-v1",
        "params": {
          "skills": {
            "sitrep":              { "mode": "autonomous" },
            "open_pr":             { "mode": "notification" },
            "merge_pr":            { "mode": "veto", "vetoTtlMs": 300000 },
            "rebase_pr":           { "mode": "gated" },
            "production_deploy":   { "mode": "gated", "reviewer": "operator" },
            "publish_post":        { "mode": "compound" }
          }
        }
      }
    ]
  }
}
```

Keys:

- `mode` (required) — one of the five values above
- `vetoTtlMs` (optional) — veto-window length in ms, only meaningful for `veto` mode. Default: 60_000 (1 minute)
- `reviewer` (optional) — `"operator"` forces the HITL prompt to the human; absent means caller-first chain (the default)
- `note` (optional) — human-readable reason, shown in the HITL prompt

`SkillBrokerPlugin` parses the declarations into `defaultHitlModeRegistry` on every card refresh (every 10 min).

---

## Consumers

- **`HITLPlugin`** — reads `x-hitl-mode` from the metadata on `input-required` and selects the rendering path: Discord button, resume-prompt, or auto-approve-on-TTL. Without the extension, falls back to legacy HITL config.
- **`TaskTracker`** — honors `vetoTtlMs` for veto-mode skills; auto-resumes the task on timeout if no cancel arrived.
- **Planner** — can compose with [blast-v1](blast-v1) to require `gated` only for skills with `radius >= repo`.
- **Dashboard** — fleet view shows which skills are gated vs. autonomous, how often each mode fires.

---

## Registry API

```ts
import {
  defaultHitlModeRegistry,
  HITL_MODE_ORDER,
  type HitlMode,
} from "../executor/extensions/hitl-mode.ts";

const decl = defaultHitlModeRegistry.get("quinn", "merge_pr");
// → { agentName: "quinn", skill: "merge_pr", mode: "veto", vetoTtlMs: 300000 }

if (decl && HITL_MODE_ORDER[decl.mode] >= HITL_MODE_ORDER.gated) {
  // Halt execution until human decides
}
```

---

## Status

- ✅ `before` hook ships on every A2A call; metadata stamping live
- ✅ Registry populated by `SkillBrokerPlugin` card-refresh path
- ✅ Caller-first reviewer resolution live — `TaskTracker` routes `input-required` back to the dispatching agent (via `meta.dispatcherAgent` on the originating `agent.skill.request`) before falling back to the human renderer chain. `reviewer: "operator"` on the declaration forces direct-to-human.

---

## Related

- [blast-v1](blast-v1) — per-skill scope declaration; compose with hitl-mode to gate high-impact skills
- [Build an A2A Agent](../guides/build-an-a2a-agent) — agent-author recipe for the A2A spec surface
- [self-improving-loop](../explanation/self-improving-loop) — how observations feed back into planner + goal proposals

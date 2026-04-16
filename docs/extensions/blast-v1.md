---
title: "Extension: x-protolabs/blast-v1"
---

`x-protolabs/blast-v1` lets agents declare the **scope of effect** for each skill so the planner, HITL policy, and dashboards can apply stricter gates to higher-impact work — independent of goal-level config.

**Extension URI**: `https://protolabs.ai/a2a/ext/blast-v1`

---

## The five radii

Ordered from narrowest to widest impact. One value per skill:

| Radius | What it affects | Typical skills |
|---|---|---|
| `self` | Only the agent's own internal state | `sitrep`, `status_report` |
| `project` | A single project's state | `manage_feature`, `board_audit` |
| `repo` | A single git repository | `open_pr`, `rebase_pr`, `pr_review` |
| `fleet` | Multiple repos or agents | `bulk_migration`, `cross_repo_bump` |
| `public` | Externally-visible state | `production_deploy`, `public_post` |

`BLAST_ORDER` assigns `self=0` through `public=4` for numeric comparisons. Consumers (e.g. HITL policy) can say "require human approval for anything ≥ `repo`".

---

## What the extension does

A **read-side** declaration — blast-v1 does NOT mutate outbound traffic or collect observations. It's policy metadata that downstream consumers look up by `(agentName, skill)`.

- **`before(ctx)`** — if the agent advertised a blast radius for this skill in their card, the interceptor stamps `x-blast-radius: <radius>` onto the outbound JSON-RPC metadata so any consumer in the execution chain can see it without a second lookup.
- **`after(ctx)`** — no-op. Blast is policy, not observation.

Registration at startup in `src/index.ts`:

```ts
import { registerBlastExtension } from "./executor/extensions/blast.ts";
registerBlastExtension();
```

---

## Declaring it on your agent card

Add to your agent card's `capabilities.extensions` list:

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://protolabs.ai/a2a/ext/blast-v1",
        "params": {
          "skills": {
            "sitrep":              { "radius": "self" },
            "pr_review":           { "radius": "repo" },
            "bulk_migration":      { "radius": "fleet", "note": "Rewrites every repo in the org" },
            "production_deploy":   { "radius": "public" }
          }
        }
      }
    ]
  }
}
```

`skills` is a map of `skill_id` → `{ radius, note? }`. `note` is a human-readable explanation shown in dashboards and HITL prompts.

When `SkillBrokerPlugin` refreshes your card (every 10 min), declarations are parsed into `defaultBlastRegistry` so the planner and HITL policy can query them without re-fetching.

---

## Consumers

Blast is useful whenever "this action is big" needs to affect routing or gating:

- **HITL policy** — the [hitl-mode-v1](hitl-mode-v1) extension can say `mode: gated` only for skills with `radius >= repo`, leaving smaller-blast work fully autonomous. The two extensions compose.
- **Planner tiebreaker** — `PlannerL0` can prefer lower-blast options when two skills produce the same effect (Arc 6.4 ranking).
- **Dashboard** — the fleet view colors skills by blast radius so operators see at a glance which work needs attention vs. which runs quietly.
- **Ops alerts** — `ops.alert.action_quality` on a `public`-radius skill is a much bigger signal than one on a `self` skill. Alert severity can scale.

---

## Registry API

```ts
import { defaultBlastRegistry, BLAST_ORDER, type BlastRadius } from "../executor/extensions/blast.ts";

const decl = defaultBlastRegistry.get("quinn", "pr_review");
// → { agentName: "quinn", skill: "pr_review", radius: "repo", note?: "..." }

// Numeric comparison for policy thresholds
if (decl && BLAST_ORDER[decl.radius] >= BLAST_ORDER["repo"]) {
  // Require human approval, stricter timeouts, etc.
}
```

Registry is populated by `SkillBrokerPlugin` on every card refresh. Missing declarations return `undefined` — consumers should treat "no declaration" as "unknown, assume worst case" or "none, proceed."

---

## Related

- [hitl-mode-v1](hitl-mode-v1) — per-skill approval policy; composes with blast to gate high-impact skills
- [cost-v1](cost-v1) — per-skill cost observations; planner tiebreaker alongside blast
- [Build an A2A Agent](../guides/build-an-a2a-agent) — agent-author recipe (task store, webhooks, health)

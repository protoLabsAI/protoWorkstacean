---
title: Operator Flows — Projects, Features, and Reviews
---

_This is an explanation doc. It describes how the day-to-day flows fit together end-to-end — onboarding a project, a feature's lifecycle, and PR review — and which component owns each step. Read it to understand what to expect when you add a project, label a Linear issue, or ask Quinn for a review._

---

## The shape

protoWorkstacean is a switchboard: it doesn't own project state, it routes. Three external systems hold the intent, and workstacean reacts:

- **protoMaker** owns the list of engineering projects (the source of truth).
- **Linear** owns higher-level issues and is where close-the-loop comments land.
- **GitHub** is where PRs live and where Quinn posts reviews.

Everything below is config-light by design: you act in protoMaker / Linear / GitHub, and workstacean fills in registry sync, Discord notifications, the Linear close-the-loop, and merge gating — with no per-project config files to edit.

## Flow 1 — Onboarding a project

1. Add the project in **protoMaker** (name + path). That's the only registration step; there is no `workspace/projects.yaml` (retired — protoMaker is the single registry of intent).
2. The in-process **`ProjectRegistry`** (`src/plugins/project-registry.ts`) polls protoMaker `GET /api/settings/global` every 5 minutes, authenticating with `AUTOMAKER_API_KEY` (sent as `X-API-Key`). For each project it derives:
   - `slug` — from the project name (lowercase, non-alphanumerics → `-`),
   - `github` `{owner, repo}` — from the repo's `.git/config` origin URL,
   - `defaultBranch` — from `.git/refs/remotes/origin/HEAD`.
3. Within ≤5 minutes the project is live everywhere that reads the registry: router GitHub-enrichment, the GitHub plugin's monitored-repo set, the clawpatch review allowlist, and `GET /api/projects`.

`ProjectRegistry` is a plain shared object (like `ChannelRegistry`), not a plugin — consumers hold a reference to the registry, never to another plugin, which keeps the bus-is-the-contract rule intact.

> **Known limitation.** `github`/`defaultBranch` are derived by reading the repo's `.git/` *inside the container*, so they only resolve for repos bind-mounted at their protoMaker path. A project that isn't mounted is still registered and routable, but its GitHub-derived behaviours (auto-review, clawpatch) stay dormant until the coordinates resolve. The durable fix is native `github`/`defaultBranch` fields on protoMaker's `ProjectRef` (tracked upstream); until then, mount the repo or expect those features to no-op for it.

## Flow 2 — Feature lifecycle and the Linear close-the-loop

```
Linear issue (trigger label)
   → LinearProtoMakerBridge files a board feature in protoMaker
   → work happens (auto-mode / agents)
   → feature hits a terminal state
   → protoMaker POSTs feature.completed | feature.failed → workstacean /publish
   → feature-notifier  → ✅/❌ to the project's dev Discord channel
   → LinearProtoMakerBridge → comment back on the originating Linear issue
```

1. A Linear issue carrying the configured trigger label fires. **`LinearProtoMakerBridge`** files a board feature in protoMaker, and the filing acknowledgement routes back to Linear as a comment.
2. When that feature reaches a **terminal state**, protoMaker emits a bus event by `POST`ing to workstacean's `/publish` endpoint (`WORKSTACEAN_URL` + `WORKSTACEAN_API_KEY` on protoMaker's side):
   - topic `feature.completed` (status → done) or `feature.failed` (blocked / escalated),
   - payload `{ projectSlug, featureId, featureTitle, prNumber?, branchName?, repo?, error? }` — `projectSlug` is required.
3. Two workstacean consumers subscribe to those topics on the in-memory bus:
   - **`feature-notifier`** posts a ✅ / ❌ embed to the project's **dev** Discord channel (resolved from `channels.yaml` via the `project:` / `kind:` binding).
   - **`LinearProtoMakerBridge`** maps the feature back to its originating Linear issue (by `featureId`, falling back to `featureTitle`) and comments "feature shipped / failed."

The net effect: a Linear ticket gets an automatic outcome comment when the board feature it spawned completes — closing the loop that filing alone couldn't.

## Flow 3 — PR review with Quinn

1. A PR is opened or synchronized (auto-review), **or** a maintainer comments **`@protoquinn review`** on the PR — a top-level PR comment routes to the `pr_review` skill (not triage).
2. Quinn (`workspace/agents/quinn.yaml`, an in-process DeepAgent posting as the `@protoquinn[bot]` GitHub App — no org seat) gathers evidence via the `pr_inspector` tool and a structural `clawpatch_review`, and:
   - **holds the formal verdict until CI is terminal** — while any check is queued / in-progress she records findings as a non-blocking `COMMENT`, never a FAIL-because-CI-is-pending,
   - **verifies external references before assigning severity** — `pr_inspector(action: path_exists)` confirms a `COPY --from` source or filtered package actually exists; a missing dependency is a real HIGH/CRITICAL, an unverifiable assumption is a *Gap*, not a fabricated severity.
3. She submits one formal verdict: `APPROVE` (PASS) / `COMMENT` (WARN) / `REQUEST_CHANGES` (FAIL).
4. **Merge gating is owned by protoMaker**, not GitHub-native auto-merge: protoMaker merges only when its eligibility check confirms Quinn approved + CI green + review threads resolved. This keeps a green-CI-but-unreviewed PR from racing to merge.

## Flow 4 — Routing and channels

- Inbound GitHub events are enriched by `RouterPlugin` with `projectSlug` + the project's `dev` channel, both resolved from the live registry + `channels.yaml`.
- Per-project Discord channels are declared in `workspace/channels.yaml` via the optional `project:` / `kind:` fields, looked up with `ChannelRegistry.getProjectChannel(slug, kind)`. Only `dev` bindings exist — release announcements go to a single shared release channel, so per-project `release` bindings were retired. No raw webhook URLs live in tracked config; delivery routes through the connected Discord bot.

## What you touch vs. what's automatic

| You do | The system does |
|--------|-----------------|
| Add a project in protoMaker | Sync it into the registry within 5 min; wire enrichment, triage, clawpatch, channels |
| Label a Linear issue | File the board feature, then comment the outcome back when it completes |
| `@protoquinn review` (or just open a PR) | Gather CI + diff + structural findings, verify cross-repo refs, post a CI-terminal verdict |
| Nothing | Notify the project dev channel on feature done/fail; gate the merge on protoMaker's eligibility check |

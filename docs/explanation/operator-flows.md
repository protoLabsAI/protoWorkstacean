---
title: Operator Flows — Projects, Routing, and Reviews
---

_This is an explanation doc. It describes how the day-to-day flows fit together end-to-end — onboarding a project, PR review, and routing — and which component owns each step. Read it to understand what to expect when you add a project or ask Quinn for a review._

---

## The shape

protoWorkstacean is a switchboard: it doesn't own project state, it routes. External systems hold the intent, and workstacean reacts:

- **GitHub** owns the list of engineering projects (repos tagged with the `protoagent-plugin` topic) and is where PRs live and where Quinn posts reviews.
- **Linear** owns higher-level issues.

Everything below is config-light by design: you tag a repo, act in Linear / GitHub, and workstacean fills in registry sync, Discord notifications, and routing — with no per-project config files to edit.

## Flow 1 — Onboarding a project

1. Tag the repo with the `protoagent-plugin` **GitHub topic** in the `protoLabsAI` org. That's the only registration step; there is no `workspace/projects.yaml` (retired).
2. `scripts/sync-project-registry.sh` (in homelab-iac, cron every 15 min) compiles every tagged repo — plus an explicit base set — into a static `projects.json`, served by the `workstacean-projects` nginx sidecar at `/api/settings/global`.
3. The in-process **`ProjectRegistry`** (`src/plugins/project-registry.ts`) polls that endpoint (URL from `PROJECT_REGISTRY_URL`) every 5 minutes. For each project it derives:
   - `slug` — from the project name (lowercase, non-alphanumerics → `-`),
   - `github` `{owner, repo}` — from the repo's `.git/config` origin URL,
   - `defaultBranch` — from `.git/refs/remotes/origin/HEAD`.
4. Within ≤5 minutes (plus up to the 15-min sync interval) the project is live everywhere that reads the registry: router GitHub-enrichment, the GitHub plugin's monitored-repo set, the clawpatch review allowlist, and `GET /api/projects`.

`ProjectRegistry` is a plain shared object (like `ChannelRegistry`), not a plugin — consumers hold a reference to the registry, never to another plugin, which keeps the bus-is-the-contract rule intact.

> **Known limitation.** `github`/`defaultBranch` are derived by reading the repo's `.git/` *inside the container*, so they only resolve for repos bind-mounted into the container. A project that isn't mounted is still registered and routable, but its GitHub-derived behaviours (auto-review, clawpatch) stay dormant until the coordinates resolve. Until then, mount the repo or expect those features to no-op for it.

## Flow 2 — PR review with Quinn

1. A PR is opened or synchronized (auto-review), **or** a maintainer comments **`@protoquinn review`** on the PR — a top-level PR comment routes to the `pr_review` skill (not triage).
2. Quinn (`workspace/agents/quinn.yaml`, an in-process DeepAgent posting as the `@protoquinn[bot]` GitHub App — no org seat) gathers evidence via the `pr_inspector` tool and a structural `clawpatch_review`, and:
   - **holds the formal verdict until CI is terminal** — while any check is queued / in-progress she records findings as a non-blocking `COMMENT`, never a FAIL-because-CI-is-pending,
   - **verifies external references before assigning severity** — `pr_inspector(action: path_exists)` confirms a `COPY --from` source or filtered package actually exists; a missing dependency is a real HIGH/CRITICAL, an unverifiable assumption is a *Gap*, not a fabricated severity.
3. She submits one formal verdict: `APPROVE` (PASS) / `COMMENT` (WARN) / `REQUEST_CHANGES` (FAIL).
4. **Merge gating** rides on GitHub-native auto-merge: a PR lands only once Quinn has approved, CI is green, and review threads are resolved. This keeps a green-CI-but-unreviewed PR from racing to merge.

## Flow 3 — Routing and channels

- Inbound GitHub events are enriched by `RouterPlugin` with `projectSlug` + the project's `dev` channel, both resolved from the live registry + `channels.yaml`.
- Per-project Discord channels are declared in `workspace/channels.yaml` via the optional `project:` / `kind:` fields, looked up with `ChannelRegistry.getProjectChannel(slug, kind)`. Only `dev` bindings exist — release announcements go to a single shared release channel, so per-project `release` bindings were retired. No raw webhook URLs live in tracked config; delivery routes through the connected Discord bot.

## What you touch vs. what's automatic

| You do | The system does |
|--------|-----------------|
| Tag a repo with the `protoagent-plugin` topic | Compile it into the registry within ~15 min; sync it in within 5 min; wire enrichment, triage, clawpatch, channels |
| `@protoquinn review` (or just open a PR) | Gather CI + diff + structural findings, verify cross-repo refs, post a CI-terminal verdict |
| Nothing | Gate the merge on Quinn's approval + green CI + resolved threads |

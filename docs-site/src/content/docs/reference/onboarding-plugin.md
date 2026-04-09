---
title: OnboardingPlugin Reference
---

_This is a reference doc. It covers the OnboardingPlugin pipeline, request schema, idempotency guarantees, trigger sources, and related tooling._

---

See also: [`how-to/onboard-a-project.md`](../how-to/onboard-a-project.md) for step-by-step operational procedures.

---

## Overview

`OnboardingPlugin` (`lib/plugins/onboarding.ts`) implements a deterministic, idempotent 9-step project provisioning pipeline. When triggered, it registers a project across Plane, GitHub, and Google Drive, then writes the project's metadata to `workspace/projects.yaml` and notifies downstream consumers.

---

## The 9-step pipeline

Steps run in sequence. Each step is individually idempotent — re-running the full pipeline for the same slug is safe.

| # | Step | What it does | Skip condition |
|---|------|-------------|----------------|
| 1 | **validate** | Checks `slug`, `title`, and `github` are present; validates `github` is `owner/repo` format; rejects duplicate in-flight runs | Missing required fields or invalid format |
| 2 | **idempotency** | Reads `workspace/projects.yaml` and exits early (success) if the slug is already registered | Slug already in `projects.yaml` |
| 3 | **plane_project** | Creates a Plane project with a derived identifier (max 12 chars, uppercase, alphanumeric) | `PLANE_API_KEY` not set |
| 4 | **plane_webhook** | Registers a Plane webhook pointing at `$WORKSTACEAN_PUBLIC_URL/webhooks/plane` | `PLANE_API_KEY` or `WORKSTACEAN_PUBLIC_URL` not set |
| 5 | **github_webhook** | Registers a GitHub repo webhook for `issues`, `issue_comment`, `pull_request`, `pull_request_review_comment` events; skips if webhook URL already registered | No GitHub auth (`QUINN_APP_ID` or `GITHUB_TOKEN`), or `WORKSTACEAN_PUBLIC_URL` not set, or webhook already exists |
| 6 | **drive_folder** | Creates a Google Drive folder under the org root folder (`drive.orgFolderId` in `workspace/google.yaml`) | Google credentials not set, `google.yaml` missing, or `drive.orgFolderId` empty |
| 7 | **projects_yaml** | Upserts the project entry into `workspace/projects.yaml` under a write lock; validates entry against `ProjectEntrySchema` before writing; preserves file header comments | Slug already present (double-checked under lock) |
| 8 | **bus_notify** | Publishes `message.inbound.onboard.complete` with project metadata and step outcomes | Never skipped |
| 9 | **reply** | Sends a confirmation message (or error) to the reply topic | No reply topic in the inbound message |

Steps 3–6 are non-fatal: an error in one step is logged, and the pipeline continues to `projects_yaml`. The pipeline aborts only if `projects_yaml` (step 7) fails.

---

## `OnboardRequest` schema

Sent as the `payload` of a `message.inbound.onboard` bus message (or the JSON body of `POST /api/onboard`):

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `slug` | `string` | ✅ | — | Unique project identifier, e.g. `"protolabsai-myproject"` |
| `title` | `string` | ✅ | — | Human-readable project name |
| `github` | `string` | ✅ | — | Repository in `"owner/repo"` format |
| `defaultBranch` | `string` | | `"main"` | Default git branch |
| `team` | `string` | | `"dev"` | Team assignment: `"dev"`, `"gtm"`, etc. |
| `agents` | `string[]` | | `["ava", "quinn"]` | Agent identifiers to associate |
| `discord` | `object` | | `{}` | Discord channel IDs (`general`, `updates`, `dev`, `alerts`, `releases`) |

---

## `lib/project-schema.ts` — Zod schema

`lib/project-schema.ts` defines the Zod schema for `workspace/projects.yaml` entries. It is used by:

- `lib/plugins/onboarding.ts` — validates each new entry before writing (step 7 fails if validation fails)
- `lib/plugins/a2a.ts` — validates on load (warns and skips invalid entries)

### `ProjectEntrySchema` fields

| Field | Required | Description |
|-------|----------|-------------|
| `slug` | ✅ | Unique project slug |
| `github` | ✅ | `"owner/repo"` format |
| `status` | ✅ | Project status string |
| `discord.dev` | ✅ | Dev channel ID (may be empty string until channel is created) |
| `title` | | Human-readable name |
| `defaultBranch` | | Git default branch |
| `team` | | Team assignment |
| `agents` | | List of agent identifiers |
| `planeProjectId` | | UUID of the corresponding Plane project |
| `onboardedAt` | | ISO 8601 timestamp of onboarding |
| `onboardingState` | | Per-step status tracking (`ok` \| `skip` \| `error`) |
| `googleWorkspace.driveFolderId` | | Google Drive folder ID created during onboarding |
| `googleWorkspace.sharedDocId` | | Project spec/brief Google Doc ID |
| `googleWorkspace.calendarId` | | Project-scoped calendar ID |

### Validation helpers

```typescript
// Validate a single raw entry
validateProjectEntry(raw: unknown): { ok: true; entry: ProjectEntry } | { ok: false; errors: string[] }

// Parse and validate the full projects.yaml structure (throws on invalid)
parseProjectsYaml(raw: unknown): ProjectsYaml
```

---

## Idempotency guarantees

The pipeline is safe to re-run for the same project slug:

1. **Step 2 (idempotency check)** exits early with `status: "already_onboarded"` if the slug is already in `projects.yaml`. No external API calls are made.
2. **Step 5 (github_webhook)** lists existing webhooks before creating; skips if the target URL is already registered.
3. **Step 7 (projects_yaml)** double-checks for the slug under a write lock before appending.
4. **In-flight guard** — concurrent requests for the same slug are rejected with an error while the first run is in progress.

---

## Inbound triggers

### Bus topic (primary)

```
message.inbound.onboard
```

Any subscriber can publish to this topic to trigger onboarding. The payload must match the `OnboardRequest` schema above.

### HTTP endpoint

```
POST /api/onboard
Content-Type: application/json

{
  "slug": "protolabsai-myproject",
  "title": "My Project",
  "github": "protoLabsAI/my-project"
}
```

The HTTP handler waits up to 30 seconds for the pipeline to complete and returns the result synchronously. If the pipeline takes longer than 30s, it returns `{ success: true, status: "accepted" }` immediately and the pipeline continues in the background.

### Discord `/onboard` slash command (M2)

The Discord plugin routes slash commands to `message.inbound.discord.slash.{interactionId}` via the command config in `workspace/discord.yaml`. An `/onboard` command configured in `discord.yaml` can pass the project fields as options and publish to `message.inbound.onboard`. Autocomplete for project fields can be configured via the `choices` option in the command spec.

### GitHub org webhook: `repository.created` (M2)

When the GitHub org webhook is registered and a new repository is created under the org, `lib/plugins/github.ts` catches the `repository` + `action: created` event and publishes to `message.inbound.onboard` automatically. The payload uses the repository's `full_name`, `name`, `owner.login`, `description`, and visibility.

---

## Outbound topics

| Topic | When published | Payload highlights |
|-------|---------------|-------------------|
| `message.inbound.onboard.complete` | After `projects_yaml` step succeeds | `slug`, `github`, `planeProjectId`, `driveFolderId`, per-step `status` |
| `{msg.reply.topic}` | After pipeline finishes (success or error) | Full result with `success`, `step`, human-readable `content` |

---

## Environment variables

| Variable | Required by | Default | Purpose |
|----------|-------------|---------|---------|
| `PLANE_API_KEY` | Steps 3, 4 | — | Enables Plane project and webhook creation |
| `PLANE_BASE_URL` | Steps 3, 4 | `http://ava:3002` | Plane instance URL |
| `PLANE_WORKSPACE_SLUG` | Steps 3, 4 | `protolabsai` | Plane workspace slug |
| `PLANE_WEBHOOK_SECRET` | Step 4 | — | Optional HMAC secret for Plane webhooks |
| `WORKSTACEAN_PUBLIC_URL` | Steps 4, 5 | — | Base URL for webhook registration (e.g. `https://ws.example.com`) |
| `QUINN_APP_ID` | Step 5 | — | GitHub App ID for auth (used by `makeGitHubAuth`) |
| `QUINN_APP_PRIVATE_KEY` | Step 5 | — | GitHub App private key |
| `GITHUB_TOKEN` | Step 5 | — | Alternative GitHub PAT for webhook registration |
| `GITHUB_WEBHOOK_SECRET` | Step 5 | — | Optional HMAC secret for GitHub webhooks |
| `GOOGLE_CLIENT_ID` | Step 6 | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Step 6 | — | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Step 6 | — | Google OAuth refresh token |

---

## Config hot-reload

The following workspace config files are watched at runtime (polled every 5 seconds by Node's `watchFile`). Changes take effect without a container restart:

| File | Watched by | What reloads |
|------|-----------|-------------|
| `workspace/github.yaml` | `GithubPlugin` | Monitored repos, org webhook config, mention handle, auto-triage settings |
| `workspace/projects.yaml` | `GithubPlugin`, `A2aPlugin` | Monitored repo list (GithubPlugin), project routing table (A2aPlugin) |
| `workspace/discord.yaml` | `DiscordPlugin` | Channel config, slash command list (re-registers commands on change) |
| `workspace/agents.yaml` | `DiscordPlugin` | Agent identity list (bot → agent mapping) |

---

## `scripts/backfill-plane.ts` (M3)

A one-shot maintenance script that creates Plane projects for all entries in `workspace/projects.yaml` that are missing a `planeProjectId`, then seeds standard workflow states and labels.

**When to run:** After migrating existing projects into `projects.yaml` manually (i.e., projects that pre-date the OnboardingPlugin or were added without going through the pipeline).

**Standard states seeded:** Todo (default), In Progress, In Review, Done, Cancelled

**Standard labels seeded:** `bug`, `feature`, `chore`

The script is fully idempotent — safe to re-run. Projects that already have a `planeProjectId` are skipped. State and label creation skips items that already exist.

```bash
# Preview changes without writing anything
bun scripts/backfill-plane.ts --dry-run

# Run for real
bun scripts/backfill-plane.ts
```

**Required env vars:** `PLANE_API_KEY`

**Optional env vars:**
- `PLANE_BASE_URL` (default: `http://ava:3002`)
- `PLANE_WORKSPACE_SLUG` (default: `protolabsai`)
- `PROJECTS_YAML_PATH` (default: `workspace/projects.yaml` relative to cwd)

---

## References

- [`lib/plugins/onboarding.ts`](../../lib/plugins/onboarding.ts) — plugin implementation
- [`lib/project-schema.ts`](../../lib/project-schema.ts) — Zod schema for `projects.yaml` entries
- [`lib/plane-client.ts`](../../lib/plane-client.ts) — Plane REST API client
- [`scripts/backfill-plane.ts`](../../scripts/backfill-plane.ts) — Plane backfill script
- [`how-to/onboard-a-project.md`](../how-to/onboard-a-project.md) — operational how-to
- [`reference/bus-topics.md`](bus-topics.md) — full bus topic registry
- [`reference/config-files.md`](config-files.md) — workspace config file reference

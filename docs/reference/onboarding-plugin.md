---
title: OnboardingPlugin Reference
---

_This is a reference doc. It covers the OnboardingPlugin pipeline, request schema, idempotency guarantees, trigger sources, and related tooling._

---

---

## Overview

`OnboardingPlugin` (`lib/plugins/onboarding.ts`) implements a deterministic, idempotent 7-step project provisioning pipeline. When triggered, it registers a project across GitHub and Google Drive, then writes the project's metadata to `workspace/projects.yaml` and notifies downstream consumers.

---

## The 7-step pipeline

Steps run in sequence. Each step is individually idempotent — re-running the full pipeline for the same slug is safe.

| # | Step | What it does | Skip condition |
|---|------|-------------|----------------|
| 1 | **validate** | Checks `slug`, `title`, and `github` are present; validates `github` is `owner/repo` format; rejects duplicate in-flight runs | Missing required fields or invalid format |
| 2 | **idempotency** | Reads `workspace/projects.yaml` and exits early (success) if the slug is already registered | Slug already in `projects.yaml` |
| 3 | **github_webhook** | Registers a GitHub repo webhook for `issues`, `issue_comment`, `pull_request`, `pull_request_review_comment` events; skips if webhook URL already registered | No GitHub auth (`QUINN_APP_ID` or `GITHUB_TOKEN`), or `WORKSTACEAN_PUBLIC_URL` not set, or webhook already exists |
| 4 | **drive_folder** | Creates a Google Drive folder under the org root folder (`drive.orgFolderId` in `workspace/google.yaml`) | Google credentials not set, `google.yaml` missing, or `drive.orgFolderId` empty |
| 5 | **projects_yaml** | Upserts the project entry into `workspace/projects.yaml` under a write lock; validates entry against `ProjectEntrySchema` before writing; preserves file header comments | Slug already present (double-checked under lock) |
| 6 | **bus_notify** | Publishes `message.inbound.onboard.complete` with project metadata and step outcomes | Never skipped |
| 7 | **reply** | Sends a confirmation message (or error) to the reply topic | No reply topic in the inbound message |

Steps 3–4 are non-fatal: an error in one step is logged, and the pipeline continues to `projects_yaml`. The pipeline aborts only if `projects_yaml` (step 5) fails.

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
| `agents` | `string[]` | | `["protomaker", "quinn"]` | Agent identifiers to associate |
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
2. **Step 3 (github_webhook)** lists existing webhooks before creating; skips if the target URL is already registered.
3. **Step 5 (projects_yaml)** double-checks for the slug under a write lock before appending.
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
| `message.inbound.onboard.complete` | After `projects_yaml` step succeeds | `slug`, `github`, `driveFolderId`, per-step `status` |
| `{msg.reply.topic}` | After pipeline finishes (success or error) | Full result with `success`, `step`, human-readable `content` |

---

## Environment variables

| Variable | Required by | Default | Purpose |
|----------|-------------|---------|---------|
| `WORKSTACEAN_PUBLIC_URL` | Step 3 | — | Base URL for webhook registration (e.g. `https://ws.example.com`) |
| `QUINN_APP_ID` | Step 3 | — | GitHub App ID for auth (used by `makeGitHubAuth`) |
| `QUINN_APP_PRIVATE_KEY` | Step 3 | — | GitHub App private key |
| `GITHUB_TOKEN` | Step 3 | — | Alternative GitHub PAT for webhook registration |
| `GITHUB_WEBHOOK_SECRET` | Step 3 | — | Optional HMAC secret for GitHub webhooks |
| `GOOGLE_CLIENT_ID` | Step 4 | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Step 4 | — | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Step 4 | — | Google OAuth refresh token |

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

## References

- [`lib/plugins/onboarding.ts`](../../lib/plugins/onboarding.ts) — plugin implementation
- [`lib/project-schema.ts`](../../lib/project-schema.ts) — Zod schema for `projects.yaml` entries
- [`reference/bus-topics.md`](bus-topics) — full bus topic registry
- [`reference/config-files.md`](config-files) — workspace config file reference

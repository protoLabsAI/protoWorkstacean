---
title: OnboardingPlugin Reference
---

_This is a reference doc. It covers the OnboardingPlugin pipeline, request schema, idempotency guarantees, and trigger sources._

---

## Overview

`OnboardingPlugin` (`lib/plugins/onboarding.ts`) runs the deterministic, idempotent side-effects of bringing a project online: registering its GitHub webhook, creating its Google Drive folder, and notifying downstream consumers.

**Project registration itself is owned by protoMaker** — protoMaker's project registry is the source of truth for project metadata (see [config-files](config-files) and [`src/plugins/project-registry.ts`](../../src/plugins/project-registry.ts)). Operators register the project in protoMaker's UI _before_ triggering onboarding here; this plugin does not create or persist a project record of its own. workstacean reads the canonical project list from protoMaker via the `ProjectRegistry` (exposed at `GET /api/projects`).

---

## The pipeline

Steps run in sequence. Each step is individually idempotent — re-running the full pipeline for the same slug is safe.

| # | Step | What it does | Skip condition |
|---|------|-------------|----------------|
| 1 | **validate** | Checks `slug`, `title`, and `github` are present; validates `github` is `owner/repo` format; rejects duplicate in-flight runs for the same slug | Missing required fields or invalid format |
| 2 | **github_webhook** | Registers a GitHub repo webhook for `issues`, `issue_comment`, `pull_request`, `pull_request_review_comment` events; lists existing webhooks first and skips if the target URL is already registered | No GitHub auth (`QUINN_APP_ID` or `GITHUB_TOKEN`), or `WORKSTACEAN_PUBLIC_URL` not set, or webhook already exists |
| 3 | **drive_folder** | Creates a Google Drive folder named after the project title, under the org root folder (`drive.orgFolderId` in `workspace/google.yaml`) | Google credentials not set, `google.yaml` missing, or `drive.orgFolderId` empty |
| 4 | **bus_notify** | Publishes `message.inbound.onboard.complete` with project metadata and per-step outcomes for downstream consumers | Never skipped |
| 5 | **reply** | Sends a confirmation message (or error) to the inbound message's reply topic | No reply topic in the inbound message |

Steps 2–3 are non-fatal: an error in one step is recorded in the step result and the pipeline continues. The plugin does not write any project file — it only performs the external side-effects and publishes the completion event.

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

These fields are echoed back on `message.inbound.onboard.complete`; the plugin does not persist them. Channel→agent bindings live in `workspace/channels.yaml` ([ChannelRegistry](workspace-files)), and project metadata lives in the protoMaker registry — neither is written by this plugin.

---

## Idempotency guarantees

The pipeline is safe to re-run for the same project slug:

1. **Step 2 (github_webhook)** lists existing webhooks before creating; skips if the target URL is already registered.
2. **Step 3 (drive_folder)** is skipped entirely when Google credentials or the org folder ID are absent.
3. **In-flight guard** — concurrent requests for the same slug are rejected with an error while the first run is in progress.

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

The HTTP handler publishes to `message.inbound.onboard` and waits for the pipeline result on the reply topic.

### Discord `/onboard` slash command

The Discord plugin routes slash commands to `message.inbound.discord.slash.{interactionId}` via the command config in `workspace/discord.yaml`. An `/onboard` command configured in `discord.yaml` can pass the project fields as options and publish to `message.inbound.onboard`.

### GitHub org webhook: `repository.created`

When the GitHub org webhook is registered and a new repository is created under the org, `lib/plugins/github.ts` catches the `repository` + `action: created` event and publishes to `message.inbound.onboard` automatically. The payload uses the repository's `full_name`, `name`, `owner.login`, `description`, and visibility.

---

## Outbound topics

| Topic | When published | Payload highlights |
|-------|---------------|-------------------|
| `message.inbound.onboard.complete` | After the pipeline runs | `slug`, `title`, `github`, `defaultBranch`, `team`, `agents`, `discord`, `driveFolderId`, per-step `status` |
| `{msg.reply.topic}` | After pipeline finishes (success or error) | Full result with `success`, `step`, human-readable `content` |

---

## Environment variables

| Variable | Required by | Default | Purpose |
|----------|-------------|---------|---------|
| `WORKSTACEAN_PUBLIC_URL` | github_webhook | — | Base URL for webhook registration (e.g. `https://ws.example.com`) |
| `QUINN_APP_ID` | github_webhook | — | GitHub App ID for auth (used by `makeGitHubAuth`) |
| `QUINN_APP_PRIVATE_KEY` | github_webhook | — | GitHub App private key |
| `GITHUB_TOKEN` | github_webhook | — | Alternative GitHub PAT for webhook registration |
| `GITHUB_WEBHOOK_SECRET` | github_webhook | — | Optional HMAC secret for GitHub webhooks |
| `GOOGLE_CLIENT_ID` | drive_folder | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | drive_folder | — | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | drive_folder | — | Google OAuth refresh token |

---

## References

- [`lib/plugins/onboarding.ts`](../../lib/plugins/onboarding.ts) — plugin implementation
- [`src/plugins/project-registry.ts`](../../src/plugins/project-registry.ts) — protoMaker-backed project registry (source of truth)
- [`reference/bus-topics.md`](bus-topics) — full bus topic registry
- [`reference/config-files.md`](config-files) — workspace config file reference

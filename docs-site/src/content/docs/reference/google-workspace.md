---
title: Google Workspace Plugin Reference
---

# Google Workspace Plugin Reference

_This is a reference doc. It covers the plugin overview, configuration schema, bus topics, credentials, and agent usage._

---

## Overview

The Google Workspace plugin (`lib/plugins/google.ts`) bridges four Google services to the Workstacean bus:

| Service | Direction | What it does |
|---------|-----------|--------------|
| **Gmail** | Inbound (polling) | Watches configured labels; publishes unread messages to the bus |
| **Calendar** | Inbound (polling) | Fetches upcoming events in the next 7 days; publishes to the bus |
| **Drive** | Outbound (subscription) | Handles file create, update, and append operations |
| **Docs** | Outbound (subscription) | Handles document create and text-insert operations |

The plugin is **disabled entirely** if any of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, or `GOOGLE_REFRESH_TOKEN` are missing. All three must be set.

`workspace/google.yaml` is **hot-reloaded** — changes apply without restarting the container. Polling intervals and label lists are restarted automatically when they change.

---

## Configuration schema — `workspace/google.yaml`

```yaml
drive:
  orgFolderId: ""        # Google Drive folder ID for the org root (shared across projects)
  templateFolderId: ""   # Per-project folder template (optional)

calendar:
  orgCalendarId: ""              # Calendar ID for the shared org calendar
  pollIntervalMinutes: 60        # How often to poll for upcoming events (default: 60)

gmail:
  watchLabels: []                # Gmail labels to watch for inbound messages
  pollIntervalMinutes: 5         # How often to poll each label (default: 5)
  routingRules: []               # Label → skillHint mappings
  # Example:
  # - label: "bug-report"
  #   skillHint: bug_triage
  # - label: "gtm-request"
  #   skillHint: content_strategy
```

### Field reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `drive.orgFolderId` | string | `""` | Root org Drive folder ID. Required for Drive operations. |
| `drive.templateFolderId` | string | `""` | Template folder for new project folders (optional). |
| `calendar.orgCalendarId` | string | `""` | Google Calendar ID (e.g. `user@example.com`). Required for Calendar polling. |
| `calendar.pollIntervalMinutes` | number | `60` | Polling interval for calendar events. |
| `gmail.watchLabels` | string[] | `[]` | Gmail label names to watch. Gmail polling is skipped if empty. |
| `gmail.pollIntervalMinutes` | number | `5` | Polling interval per label. |
| `gmail.routingRules` | RoutingRule[] | `[]` | Maps a label to a `skillHint` attached to the published bus message. |

#### `RoutingRule`

```yaml
- label: "bug-report"    # Gmail label name (case-insensitive)
  skillHint: bug_triage  # Skill hint attached to the published message payload
```

---

## `projects.yaml` extensions

Per-project Google Workspace overrides can be added to each project entry in `workspace/projects.yaml`:

```yaml
projects:
  - slug: my-project
    # ...
    googleWorkspace:
      driveFolderId: "1ABC123XYZ"   # Project-specific Drive folder
      sharedDocId: "1DEF456UVW"     # Shared Google Doc for this project
      calendarId: "team@example.com" # Project-specific calendar (overrides org default)
```

| Field | Type | Description |
|-------|------|-------------|
| `googleWorkspace.driveFolderId` | string | Project Drive folder ID. Used by Cindi when creating project files. |
| `googleWorkspace.sharedDocId` | string | Shared Google Doc ID. Used by Jon and Quinn for running notes. |
| `googleWorkspace.calendarId` | string | Project calendar ID. Overrides `calendar.orgCalendarId` for this project. |

---

## Bus topics

### Inbound topics (published by the plugin)

| Topic | Trigger | Payload fields |
|-------|---------|----------------|
| `message.inbound.google.gmail` | New unread message found matching a watched label | `messageId`, `threadId`, `label`, `from`, `to`, `subject`, `date`, `body` (≤4000 chars), `skillHint` (if routing rule matched) |
| `message.inbound.google.calendar` | Calendar poll found upcoming events | `events[]` (id, title, description, start, end, attendees, link), `window` (from, to) |

### Outbound topics (subscribed by the plugin)

Publish to these topics to trigger Drive or Docs operations. Set `reply.topic` on your message to receive the result.

#### `message.outbound.google.drive`

| `operation` | Required fields | Optional fields | Returns |
|-------------|----------------|-----------------|---------|
| `create` | `name`, `mimeType` | `parentId`, `content` | `fileId`, `name`, `webViewLink` |
| `update` | `fileId`, `content` | — | `fileId`, `name` |
| `append` | `fileId`, `content` | — | `fileId`, `name` |

Example:
```json
{
  "operation": "create",
  "name": "Project Brief",
  "mimeType": "text/plain",
  "parentId": "1ABC123XYZ",
  "content": "Initial content here"
}
```

#### `message.outbound.google.docs`

| `operation` | Required fields | Optional fields | Returns |
|-------------|----------------|-----------------|---------|
| `create` | `title` | `content` | `documentId`, `title`, `link` |
| `insert` | `documentId`, `content` | `index` (default: 1) | `documentId`, `link` |
| `update` | `documentId`, `content` | `index` (default: 1) | `documentId`, `link` |

Example:
```json
{
  "operation": "create",
  "title": "Sprint Retro — 2026-Q1",
  "content": "## Summary\n\n..."
}
```

### System topics

| Topic | When | Payload |
|-------|------|---------|
| `auth.token_refresh_failed` | Access token refresh failed after 3 retries | `{ plugin: "google", reason: string }` |
| `config.updated` | `google.yaml` was hot-reloaded | `{ plugin: "google", config: "google.yaml" }` |

---

## Credentials

All three secrets must be injected at runtime (from Infisical, project `11e172e0-a1f6-41d5-9464-df72779a7063`, env `prod`):

| Secret | Infisical key | Description |
|--------|---------------|-------------|
| OAuth2 client ID | `GOOGLE_CLIENT_ID` | Created in Google Cloud Console → APIs & Services → Credentials |
| OAuth2 client secret | `GOOGLE_CLIENT_SECRET` | Paired with the client ID |
| OAuth2 refresh token | `GOOGLE_REFRESH_TOKEN` | Long-lived token; exchanged for short-lived access tokens automatically |

The plugin refreshes the access token automatically. Tokens are cached in memory with a 5-minute safety buffer. A background job proactively refreshes when fewer than 10 minutes remain.

---

## Agents that use this plugin

| Agent | Services used | How |
|-------|--------------|-----|
| **Jon** | Docs | Creates and updates Google Docs for project artefacts |
| **Cindi** | Drive | Creates per-project folders; uploads files to Drive |
| **Ava** | Calendar | Reads upcoming events via `message.inbound.google.calendar` to signal deadlines |
| **Quinn** | Docs | Reads and writes shared Docs for portfolio summaries and PR reviews |

---

## See also

- [`docs/how-to/set-up-google-workspace.md`](\1/) — step-by-step OAuth2 setup
- [`docs/reference/bus-topics.md`](\1/) — full bus topic catalogue
- [`docs/reference/config-files.md`](\1/) — all workspace config files

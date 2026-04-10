---
title: How to Set Up Google Workspace
---


_This is a how-to guide. It covers OAuth2 credentials, the `google.yaml` configuration, and enabling Drive, Calendar, and Gmail integration._

---

The Google Workspace plugin (`lib/plugins/google.ts`) bridges Google Drive, Calendar, and Gmail to the Workstacean bus. Each service is independently optional — configure only the ones you need.

---

## 1. Create a Google Cloud project and OAuth2 credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project.
2. Enable the APIs you need:
   - **Google Drive API**
   - **Google Calendar API**
   - **Gmail API**
3. Under **APIs & Services → Credentials**, create an **OAuth 2.0 Client ID** (type: Web application or Desktop app depending on your setup).
4. Download the credentials JSON and store the relevant values as environment variables:

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | Long-lived refresh token (obtained via OAuth2 flow) |

The plugin is **skipped** if `GOOGLE_CLIENT_ID` is not set.

### Obtaining the refresh token

Run the OAuth2 authorization flow once to get a refresh token:

```bash
# Use the Google OAuth2 playground or a one-shot script:
# https://developers.google.com/oauthplayground/
```

Store the refresh token in Infisical (AI project `11e172e0`) under `GOOGLE_REFRESH_TOKEN`. The plugin exchanges it for access tokens automatically.

---

## 2. Configure google.yaml

Place `google.yaml` in your workspace directory (default: `workspace/google.yaml`):

```yaml
# workspace/google.yaml

drive:
  orgFolderId: ""         # root org Drive folder — shared across all projects
  templateFolderId: ""    # per-project folder template (optional)

calendar:
  orgCalendarId: ""               # shared org calendar for milestones/deadlines
  pollIntervalMinutes: 60         # how often to check for upcoming events

gmail:
  watchLabels: []                 # Gmail labels to monitor for inbound routing
  pollIntervalMinutes: 5          # how often to poll for new messages
  routingRules: []                # label → skillHint mappings
  # Example routingRules:
  # - label: "bug-report"
  #   skillHint: bug_triage
  # - label: "gtm-request"
  #   skillHint: content_review
```

---

## 3. Enable Drive integration

Set `drive.orgFolderId` to the Google Drive folder ID you want to use as the org root. The folder ID is the last path component of the Drive URL:

```
https://drive.google.com/drive/folders/1ABC123XYZ
                                        ^^^^^^^^^^^
                                        this is the ID
```

The plugin will surface Drive events to the bus. Agents can read/write Drive files via the available Drive tools.

---

## 4. Enable Calendar integration

Set `calendar.orgCalendarId` to your shared org calendar's ID (found in Google Calendar → Settings → Calendar Settings → Calendar ID — typically an email-like string).

The plugin polls the calendar every `pollIntervalMinutes` for upcoming events and publishes them to:

```
google.calendar.event.upcoming
```

Agents subscribed to this topic can trigger reminders, board updates, or ceremony checks.

---

## 5. Enable Gmail routing

Gmail routing turns labeled emails into bus messages routed to specific skills.

```yaml
gmail:
  watchLabels:
    - "bug-report"
    - "gtm-request"
  pollIntervalMinutes: 5
  routingRules:
    - label: "bug-report"
      skillHint: bug_triage
    - label: "gtm-request"
      skillHint: content_review
```

The plugin polls Gmail every `pollIntervalMinutes`, finds messages with the specified labels, and publishes them to:

```
message.inbound.gmail.{label}
```

with `skillHint` set from `routingRules`. The A2APlugin routes these to the appropriate agent.

---

## 6. Restart to apply changes

```bash
docker restart workstacean
```

On startup, the plugin logs which services it activated:

```
[GooglePlugin] Drive enabled — orgFolderId: 1ABC123XYZ
[GooglePlugin] Calendar enabled — polling every 60 minutes
[GooglePlugin] Gmail enabled — watching labels: bug-report, gtm-request
```

---

## Related docs

- [reference/bus-topics.md](../reference/bus-topics.md) — Google bus topics
- [reference/config-files.md](../reference/config-files.md) — full `google.yaml` schema
- [explanation/plugin-lifecycle.md](../explanation/plugin-lifecycle.md) — plugin install/uninstall lifecycle

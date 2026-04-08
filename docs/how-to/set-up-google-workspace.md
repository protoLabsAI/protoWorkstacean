# How to Set Up Google Workspace

_This is a how-to guide. It covers OAuth2 credentials, the `google.yaml` configuration, and enabling Drive, Calendar, and Gmail integration._

---

The Google Workspace plugin (`lib/plugins/google.ts`) bridges Google Drive, Calendar, Gmail, and Docs to the Workstacean bus. Each service is independently optional — configure only the ones you need.

---

## 1. Create a Google Cloud project and OAuth2 credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create or select a project.
2. Enable the APIs you need under **APIs & Services → Library**:
   - **Google Drive API**
   - **Google Calendar API**
   - **Gmail API**
   - **Google Docs API**
3. Under **APIs & Services → Credentials**, create an **OAuth 2.0 Client ID**.
   - Choose **Web application** as the type.
   - Add `http://localhost:8765` as an authorized redirect URI.
4. Note the **Client ID** and **Client Secret**.

---

## 2. Obtain a refresh token

Run the OAuth2 authorization flow once to obtain a long-lived refresh token.

**Option A — Google OAuth2 Playground**

1. Visit [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground).
2. In Settings (gear icon), check **Use your own OAuth credentials** and enter your Client ID and Client Secret.
3. Select the following scopes:
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/documents`
4. Authorize, then exchange the authorization code for tokens.
5. Copy the **refresh token** from the response.

**Option B — manual curl flow**

```bash
# Step 1: Visit this URL in a browser and authorize
# Replace CLIENT_ID with yours
https://accounts.google.com/o/oauth2/v2/auth?\
  client_id=CLIENT_ID&\
  redirect_uri=http%3A%2F%2Flocalhost%3A8765&\
  response_type=code&\
  scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive+\
        https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar+\
        https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify+\
        https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdocuments&\
  access_type=offline&\
  prompt=consent

# Step 2: Exchange the code for a refresh token
curl -s -X POST https://oauth2.googleapis.com/token \
  -d "code=CODE&\
      client_id=CLIENT_ID&\
      client_secret=CLIENT_SECRET&\
      redirect_uri=http://localhost:8765&\
      grant_type=authorization_code"
```

Copy the `refresh_token` value from the JSON response.

---

## 3. Store credentials in Infisical

Store all three values in Infisical (project `11e172e0-a1f6-41d5-9464-df72779a7063`, env `prod`):

| Infisical key | Value |
|---------------|-------|
| `GOOGLE_CLIENT_ID` | OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | Refresh token from step 2 |

The plugin reads these at startup. If any are missing, the plugin logs a message and disables itself:

```
[google] GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN not set — plugin disabled
```

---

## 4. Configure `workspace/google.yaml`

Place `google.yaml` in your workspace directory (default: `workspace/google.yaml`):

```yaml
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
  #   skillHint: content_strategy
```

### Setting `drive.orgFolderId`

The folder ID is the last path segment of the Drive folder URL:

```
https://drive.google.com/drive/folders/1ABC123XYZ
                                        ^^^^^^^^^^^
                                        this is the ID
```

### Setting `calendar.orgCalendarId`

Find this in Google Calendar → Settings → the calendar → **Calendar ID**. It usually looks like an email address (`team@example.com` or a long `@group.calendar.google.com` string).

### Configuring Gmail routing

Gmail routing turns labeled emails into bus messages routed to specific skills:

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
      skillHint: content_strategy
```

The plugin polls Gmail every `pollIntervalMinutes`, finds unread messages with the specified labels, and publishes them to `message.inbound.google.gmail` with `skillHint` set from `routingRules`.

---

## 5. Verify the plugin started

After setting credentials and restarting the container, look for these log lines:

```
[google] Access token refreshed (expires in 3599s)
[google] Gmail poller started (interval: 5m, labels: bug-report, gtm-request)
[google] Calendar poller started (interval: 60m)
[google] Plugin installed — Drive, Docs, Gmail, Calendar active
```

If a service is skipped due to missing config, it logs a message explaining why:

```
[google] Gmail polling skipped — no watchLabels configured
[google] Calendar polling skipped — no orgCalendarId configured
```

---

## Related docs

- [reference/google-workspace.md](../reference/google-workspace.md) — full config schema, bus topics, and agent reference
- [reference/bus-topics.md](../reference/bus-topics.md) — complete bus topic catalogue
- [reference/config-files.md](../reference/config-files.md) — all workspace config files

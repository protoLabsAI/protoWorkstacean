# How to Onboard a Project

_This is a how-to guide. It covers prerequisites, the three ways to trigger onboarding, how to check onboard status, and how to re-run idempotently._

---

See also: [`reference/onboarding-plugin.md`](../reference/onboarding-plugin.md) for the full pipeline reference, `OnboardRequest` schema, and environment variable docs.

---

## Prerequisites

Before onboarding, have the following ready:

| Prerequisite | Why needed |
|-------------|-----------|
| A GitHub repository (`owner/repo`) | Required field — the pipeline registers a webhook on this repo |
| A unique project `slug` | Used as the primary key in `projects.yaml` (e.g. `protolabsai-myproject`) |
| A project `title` | Human-readable name written to `projects.yaml` |
| Discord channel IDs (optional) | Passed in the `discord` field; `discord.dev` is written to `projects.yaml` |

**Environment prerequisites** (see [`reference/onboarding-plugin.md`](../reference/onboarding-plugin.md) for full list):

- `PLANE_API_KEY` — required for Plane project and webhook creation (steps 3–4 skip if absent)
- `WORKSTACEAN_PUBLIC_URL` — required for webhook registration (steps 4–5 skip if absent)
- GitHub auth (`QUINN_APP_ID`/`QUINN_APP_PRIVATE_KEY` or `GITHUB_TOKEN`) — required for GitHub webhook (step 5 skips if absent)
- Google credentials — required for Drive folder creation (step 6 skips if absent)

Missing env vars cause individual steps to be skipped, not the whole pipeline.

---

## Option A — Via Discord `/onboard` slash command (M2)

In any Discord channel the bot has access to, use the `/onboard` slash command. The command is registered via `workspace/discord.yaml` and routes the interaction to `message.inbound.onboard` on the bus.

Example (slash command with options):

```
/onboard slug:protolabsai-myproject title:My Project github:protoLabsAI/my-project
```

The bot replies with a step-by-step summary once the pipeline completes (or an error if a step fails).

---

## Option B — Via HTTP `POST /api/onboard`

```bash
curl -s -X POST http://localhost:3000/api/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "protolabsai-myproject",
    "title": "My Project",
    "github": "protoLabsAI/my-project"
  }'
```

The endpoint waits up to 30 seconds for the pipeline to complete and returns the result:

```json
{
  "success": true,
  "step": "complete",
  "status": "onboarded",
  "slug": "protolabsai-myproject",
  "github": "protoLabsAI/my-project",
  "steps": {
    "planeProject": "ok",
    "planeWebhook": "ok",
    "githubWebhook": "ok",
    "driveFolder": "skip",
    "projectsYaml": "ok"
  }
}
```

If the pipeline takes longer than 30s, the response is `{ "success": true, "status": "accepted" }` and onboarding continues in the background.

**Full optional fields:**

```bash
curl -s -X POST http://localhost:3000/api/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "protolabsai-myproject",
    "title": "My Project",
    "github": "protoLabsAI/my-project",
    "defaultBranch": "main",
    "team": "dev",
    "agents": ["ava", "quinn"],
    "discord": {
      "dev": "123456789012345678",
      "alerts": "123456789012345679"
    }
  }'
```

---

## Option C — Via bus message `message.inbound.onboard`

Publish directly to the bus (useful in CI or scripts):

```bash
curl -s -X POST http://localhost:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "message.inbound.onboard",
    "payload": {
      "slug": "protolabsai-myproject",
      "title": "My Project",
      "github": "protoLabsAI/my-project"
    }
  }'
```

This is fire-and-forget — no response is returned by the `/publish` endpoint. The pipeline runs asynchronously. To get a result, use the HTTP endpoint (Option B) instead, or subscribe to `message.inbound.onboard.complete` on the bus.

---

## Option D — Automatically via GitHub org webhook (M2)

If the GitHub org webhook is registered, any new repository created under the org automatically triggers onboarding. No manual action needed.

The `GithubPlugin` catches `repository.created` events and publishes to `message.inbound.onboard` with the repository's name, owner, and description as the payload. The slug is derived from the repository's `full_name`.

---

## How to check onboard status

### Check `workspace/projects.yaml`

After onboarding, the project appears in `workspace/projects.yaml`:

```yaml
projects:
  - slug: protolabsai-myproject
    title: My Project
    github: protoLabsAI/my-project
    status: active
    defaultBranch: main
    team: dev
    agents: [ava, quinn]
    onboardedAt: "2026-04-08T12:00:00.000Z"
    planeProjectId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    discord:
      dev: ""
    googleWorkspace:
      driveFolderId: ""
      sharedDocId: ""
      calendarId: ""
```

### Check via HTTP

```bash
curl -s http://localhost:3000/api/projects | jq '.projects[] | select(.slug == "protolabsai-myproject")'
```

### Check container logs

```bash
docker logs workstacean 2>&1 | grep "onboarding.*protolabsai-myproject"
```

Each pipeline step logs its outcome:

```
[onboarding] Starting pipeline for "protolabsai-myproject" (protoLabsAI/my-project)
[onboarding] Step 3 plane_project: ok — Created Plane project "My Project" (uuid)
[onboarding] Step 4 plane_webhook: ok — Plane webhook registered → https://ws.example.com/webhooks/plane
[onboarding] Step 5 github_webhook: ok — GitHub webhook registered on protoLabsAI/my-project
[onboarding] Step 6 drive_folder: skip — Google credentials not set
[onboarding] Step 7 projects_yaml: ok — Appended "protolabsai-myproject" to projects.yaml
[onboarding] Step 8 bus_notify: ok — published message.inbound.onboard.complete
[onboarding] Step 9 reply: ok — protolabsai-myproject onboarded
```

---

## How to re-run idempotently

Re-running the pipeline for an already-onboarded project is safe. Step 2 (idempotency check) reads `projects.yaml`, finds the slug, and returns immediately:

```json
{
  "success": true,
  "step": "idempotency",
  "status": "already_onboarded",
  "slug": "protolabsai-myproject",
  "message": "Project \"protolabsai-myproject\" is already registered in projects.yaml"
}
```

No external API calls are made during an idempotency-skip run.

**To force re-onboarding** (e.g., to re-register webhooks or recreate a Plane project after deletion):

1. Remove or rename the entry in `workspace/projects.yaml`
2. Re-run any trigger from Options A–D above

---

## Backfilling existing projects (M3)

For projects added to `projects.yaml` manually (before the OnboardingPlugin, or via direct YAML edit), use the backfill script to create the missing Plane projects and seed standard states/labels:

```bash
# Preview what would change
bun scripts/backfill-plane.ts --dry-run

# Apply
bun scripts/backfill-plane.ts
```

The script is idempotent — safe to re-run. It only acts on entries missing a `planeProjectId`.

---

## Related docs

- [`reference/onboarding-plugin.md`](../reference/onboarding-plugin.md) — full pipeline reference, OnboardRequest schema, env vars
- [`reference/bus-topics.md`](../reference/bus-topics.md) — full bus topic registry
- [`reference/config-files.md`](../reference/config-files.md) — `projects.yaml` and workspace config file reference

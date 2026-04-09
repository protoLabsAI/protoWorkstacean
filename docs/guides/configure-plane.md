# Plane Integration

Plane is the project management layer for protoLabs. It acts as the human-facing strategic interface: ideas become Plane issues, Plane issues become SPARC PRDs, and approved PRDs become board features in the protoLabs Studio backlog. Workstacean is the bridge.

## 1. Overview

Plane is self-hosted at `plane.proto-labs.ai` (Docker container `ava:3002`). The workspace slug is `protolabsai` and the workspace ID is `b761769f-0172-40cc-9bce-8dd35c940815`.

The flow in one sentence: a Plane issue labelled `plan` or `auto` fires a webhook → Workstacean's `PlanePlugin` validates and deduplicates the event → publishes to the internal bus → Ava runs SPARC PRD + antagonistic review → HITL approval gate (skipped for `auto`) → features created on the board → Plane issue state and a summary comment are synced back.

## 2. Setup

### Webhook creation — use Django ORM, not the UI or API

The Plane API key (`/api/v1/` paths) works fine for reading and writing workspace data. The webhook management endpoint lives at `/api/workspaces/{slug}/webhooks/`, which is session-authenticated only. Trying to create a webhook via API key returns 401 even though the response body looks like a generic DRF 401 (not a helpful "session required" message).

The only reliable way to create or update the webhook is directly via Django ORM in the Plane container:

```bash
docker exec -it plane-api python manage.py shell
```

```python
from plane.db.models import Webhook, Workspace
ws = Workspace.objects.get(slug="protolabsai")
wh = Webhook.objects.create(
    workspace=ws,
    url="http://workstacean:8083/webhooks/plane",
    is_active=True,
    issue=True,      # fires on create/update/delete
    cycle=False,
    module=False,
    project=False,
)
print(wh.secret_key)  # copy this — store as PLANE_WEBHOOK_SECRET
```

The `secret_key` printed by the ORM is the HMAC secret. Store it immediately — you cannot retrieve it again after the shell session.

### API path gotcha

| Path prefix | Auth method | Works for |
|---|---|---|
| `/api/v1/workspaces/...` | API key (`X-Api-Key` header) | Issues, states, projects, members |
| `/api/workspaces/...` | Session cookie only | Webhooks, some admin paths |

If you hit a 401 on `/api/workspaces/...` with a valid API key, this is a Django REST Framework routing bug — the path is not registered under the API-key-authenticated router at all. Switch to the Django ORM approach.

## 3. Trigger Rules

The `PlanePlugin` (`lib/plugins/plane.ts`) filters inbound webhook events by label:

| Label | Behaviour |
|---|---|
| `plan` | Routes to Ava via bus, requires HITL approval before features are created |
| `auto` | Routes to Ava via bus, skips HITL gate entirely — features created immediately |
| (anything else) | Silently dropped |

Only `issue` events (create/update/delete) are subscribed. Project/cycle/module events are ignored.

## 4. Plane → Workstacean → Ava Flow

```
1. Plane issue created/updated with "plan" or "auto" label
2. POST /webhooks/plane (port 8083 on workstacean container)
3. PlanePlugin:
   a. Verify HMAC-SHA256 signature against PLANE_WEBHOOK_SECRET
      → 401 if invalid
   b. Check X-Plane-Delivery UUID against 10k-entry deduplication ring
      → silent drop if already seen
   c. Check issue labels for "plan" or "auto"
      → silent drop if neither label present
   d. Extract planeIssueId and planeProjectId
   e. Publish to bus:
      topic:     message.inbound.plane.issue.create
      skillHint: "plan"
      correlationId: plane-{issueId}
   f. Store {planeIssueId, planeProjectId} in pendingIssues Map keyed by correlationId
4. A2APlugin routes to Ava (skillHint "plan" → plan skill)
5. Ava runs SPARC PRD + antagonistic review (Ava operational lens + Jon strategic lens)
6. HITL gate:
   - "auto" label → skip gate, emit HITLResponse(approve) internally
   - "plan" label → emit HITLRequest to plane.reply.{correlationId}
7. On approval: Ava's plan_resume creates board features, stamps correlationId
8. PlanePlugin outbound handler picks up plane.reply.# events → syncs back to Plane
```

## 5. Bidirectional Sync

After a plan is approved and features are created, the `PlanePlugin` outbound handler subscribes to `plane.reply.#` and performs two API calls against `PLANE_BASE_URL` (`http://ava:3002`):

1. **PATCH issue state**: sets the issue to "In Progress" when a plan is approved; sets it to "Done" when the plan completes (all features created).
2. **POST comment**: posts a summary comment to the issue with a brief description of what was planned and which features were created.

### The pendingIssues Map

A2A replies don't carry Plane metadata — they only carry `correlationId`. When the `PlanePlugin` first publishes an event it stores `{planeIssueId, planeProjectId}` in a `pendingIssues` Map keyed by `correlationId` (format: `plane-{issueId}`). The outbound handler looks up this map to reconstruct the API call targets. The map is in-memory and not persisted; a workstacean restart clears it, which means in-flight approvals would lose their sync-back path (the board features still get created; only the Plane state update is lost).

## 6. Secrets

All secrets live in Infisical. Two projects hold Plane-related secrets:

| Secret | Infisical Project | Notes |
|---|---|---|
| `PLANE_WEBHOOK_SECRET` | AI project (`11e172e0`) and homelab project | HMAC key from Django ORM creation step |
| `PLANE_API_KEY` | AI project (`11e172e0`) | For `/api/v1/` reads and writes |

Workstacean env vars (set via `infisical run`):

```
PLANE_WEBHOOK_SECRET   — HMAC validation for incoming webhooks
PLANE_API_KEY          — outbound API calls to Plane
PLANE_BASE_URL         — defaults to http://ava:3002
PLANE_WORKSPACE_SLUG   — defaults to protolabsai
```

These are declared in `stacks/ai/docker-compose.yml` in the homelab-iac repo under the `workstacean` service.

## 7. Bus Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `message.inbound.plane.issue.create` | Published (inbound) | New issue event with `skillHint: "plan"` |
| `message.inbound.plane.issue.update` | Published (inbound) | Update event (currently not routed) |
| `plane.reply.{issueId}` | Subscribed (outbound) | A2A reply — triggers state PATCH + comment |

## 8. BusMessage Shape

The inbound message published to `message.inbound.plane.issue.create`:

```ts
{
  correlationId: "plane-{issueId}",
  source: { interface: "plane", channelId: projectId, userId: actorId },
  reply: { topic: "plane.reply.{issueId}", format: "structured" },
  payload: {
    planeIssueId, planeProjectId, planeWorkspaceId,
    planeSequenceId,
    title,         // issue name
    description,   // stripped description
    content,       // "Plan: {name}\n\n{description}" — sent to Ava
    priority,      // "urgent" | "high" | "medium" | "low" | "none"
    labels,        // raw UUID array
    autoApprove,   // true if "auto" label present
    skillHint: "plan",
  }
}
```

## 9. onboard_project Auto-Provisioning

The `onboard_project` skill (Step 9 of the onboarding chain, triggered on Ava) auto-creates a Plane project for newly onboarded repos:

1. Calls `POST /api/v1/workspaces/protolabsai/projects/` with the project name and identifier derived from the repo name.
2. Stores the returned `plane_project_id` in two places:
   - `.proto/settings.json` inside the target repo
   - `workspace/projects.yaml` (the authoritative project registry in this repo)

This means every onboarded project gets a matching Plane project without manual setup.

## 10. MCP Server

`plane-mcp-server` is configured in Ava's `.mcp.json`. All agents running on the Ava host inherit 55+ Plane MCP tools covering issues, cycles, modules, members, states, and projects. This allows agents to read and write Plane data directly as tool calls without going through the webhook flow.

## 11. Security

- **Signature**: `X-Plane-Signature: sha256=<hex>` — HMAC-SHA256 of the raw body.
- **Deduplication**: `X-Plane-Delivery` ring buffer (10,000 entries) prevents replay.
- **Async response**: Plane receives `200 OK` immediately; processing runs async to avoid webhook timeouts.

## 12. Known Gotchas

**API path quirk**: `/api/v1/workspaces/...` uses API-key auth; `/api/workspaces/...` is session-only. Both return 401 for unknown paths as well, which makes debugging confusing — a 401 does not always mean wrong credentials, it can mean the path is not registered. Always confirm the path prefix before concluding the API key is invalid.

**`drop_params: true` in LiteLLM**: LangChain's `ChatOpenAI` sends `top_p: -1` when routing through a Claude fallback. This is an invalid value that Claude rejects. `drop_params: true` is set in `general_settings` in the LiteLLM config, which strips unknown/invalid parameters before forwarding to the model backend. Without this, Plane-triggered plan requests that hit the Claude fallback fail immediately.

**pendingIssues Map is ephemeral**: See Section 5. A workstacean restart during an active HITL approval cycle loses the sync-back context. The PRD and features are safe (PlanStore is SQLite-backed); only the Plane issue state update is affected.

**Webhook fires on updates too**: The webhook is subscribed to all `issue` events including updates. If someone edits an already-processed issue and the `plan` label is still present, it will fire again. The 10k-entry deduplication ring by `X-Plane-Delivery` UUID prevents duplicate processing per delivery, but a new edit generates a new delivery UUID. The plan skill itself is idempotent at the PRD level (correlationId is stable), but be aware that editing an issue title after it has been processed will re-trigger the full flow.

## 13. Testing

### Layer 1 — Webhook signature verification

```bash
# Confirm workstacean accepts a correctly-signed payload
PAYLOAD='{"action":"created","issue":{"id":"test-123","labels":[{"name":"plan"}]}}'
SECRET=$(infisical secrets get PLANE_WEBHOOK_SECRET --domain https://secrets.proto-labs.ai/api --env=prod --plain)
SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
curl -s -o /dev/null -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -H "X-Plane-Signature: $SIG" \
  -H "X-Plane-Delivery: $(uuidgen)" \
  -d "$PAYLOAD" \
  http://ava:8083/webhooks/plane
# Expect 200
```

### Layer 2 — Bus injection (bypass webhook, test routing)

```bash
# Inject a pre-validated bus message directly
curl -s -X POST http://ava:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "message.inbound.plane.issue.create",
    "payload": {
      "skillHint": "plan",
      "correlationId": "plane-test-001",
      "content": "Build a Discord notification digest for daily standup",
      "source": { "interface": "plane", "channelId": "test-001" },
      "reply": { "topic": "plane.reply.plane-test-001", "format": "text" }
    }
  }'
```

### Layer 3 — Full end-to-end

1. Create a Plane issue in workspace `protolabsai` with a brief description and the `plan` label.
2. Watch workstacean logs: `docker logs -f workstacean | grep plane`
3. Confirm HMAC validation, dedup check, and bus publish log lines.
4. Wait for Ava to complete PRD generation (check Langfuse for the trace).
5. An HITL embed should appear in the configured Discord channel (or reply to the Plane issue if rendered there).
6. Approve via Discord or inject approval (see [hitl.md](hitl.md) for inject commands).
7. Confirm Plane issue state changes to "In Progress" and a comment is posted.

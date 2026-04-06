# Plane Integration

Bridges Plane (project management) to the Workstacean bus. Issue creation events with the right labels trigger the `plan` skill on Ava. Ava's response syncs back to the Plane issue as a state change and comment.

## How It Works

```
Issue created in Plane with "plan" or "auto" label (or top-level epic with no parent)
  → PlanePlugin validates HMAC-SHA256 signature
    → Deduplicates by X-Plane-Delivery header
      → Publishes message.inbound.plane.issue.create (skillHint: "plan")
        → A2APlugin routes to Ava
          → Ava generates SPARC PRD + antagonistic review
            → auto-approve OR HITLRequest
              → On approval: features created, correlationId stamped
                → Ava publishes plane.reply.{issueId}
                  → PlanePlugin PATCHes issue state → "Done"
                  → PlanePlugin POSTs completion comment
```

## Trigger Rules

| Condition | Routed? | Auto-approve? |
|-----------|---------|---------------|
| Label `plan` on issue | Yes | No — HITL gate |
| Label `auto` on issue | Yes | Yes — skip HITL |
| Top-level issue (no parent) | Yes | No — HITL gate |
| Child issue / no matching label | No | — |

Labels are resolved by UUID via the Plane REST API and cached per project. The cache is invalidated when a project update event is received.

## Setup

### 1. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PLANE_WEBHOOK_SECRET` | Recommended | HMAC-SHA256 secret for signature verification. If unset, verification is skipped (dev mode). |
| `PLANE_API_KEY` | Yes (for outbound) | Plane API key — enables state PATCH and comment POST. Outbound calls are disabled if unset. |
| `PLANE_BASE_URL` | No | Plane instance URL. Default: `http://ava:3002` |
| `PLANE_WORKSPACE_SLUG` | No | Plane workspace slug. Default: `protolabsai` |
| `PLANE_WEBHOOK_PORT` | No | Port for the webhook HTTP server. Default: `8083` |

### 2. Configure Plane Webhook

In Plane, go to **Settings → Webhooks** and create a new webhook:

- **URL**: `http://<workstacean-host>:8083/webhooks/plane`
- **Events**: Issue (create, update)
- **Secret**: set to the same value as `PLANE_WEBHOOK_SECRET`

### 3. Labels

Create at least one label in each Plane project you want to use:

| Label name | Behaviour |
|------------|-----------|
| `plan` | Triggers planning; routes through HITL approval gate |
| `auto` | Triggers planning; skips HITL and auto-approves |

Label matching is case-insensitive.

## Outbound State Sync

When Ava finishes planning and publishes to `plane.reply.{issueId}`, the PlanePlugin:

1. Resolves state UUIDs for the project via the Plane `/states/` endpoint.
2. PATCHes the issue state:
   - `status: created | in_progress` → state group `started` (In Progress)
   - `status: completed | done` → state group `completed` (Done)
3. POSTs a comment with the plan summary.

Plane context (`planeIssueId`, `planeProjectId`) is carried through A2A hops via an in-memory `pendingIssues` map keyed by `correlationId`.

## Bus Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `message.inbound.plane.issue.create` | Published (inbound) | New issue event with `skillHint: "plan"` |
| `message.inbound.plane.issue.update` | Published (inbound) | Update event (currently not routed) |
| `plane.reply.{issueId}` | Subscribed (outbound) | A2A reply — triggers state PATCH + comment |

## BusMessage Shape

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

## Security

- **Signature**: `X-Plane-Signature: sha256=<hex>` — HMAC-SHA256 of the raw body.
- **Deduplication**: `X-Plane-Delivery` ring buffer (10,000 entries) prevents replay.
- **Async response**: Plane receives `200 OK` immediately; processing runs async to avoid webhook timeouts.

---
title: HITL — Human-in-the-Loop Gate
---

HITL is the approval gate that sits between Ava generating a SPARC PRD and features landing on the board. It exists because autonomous project creation has permanent side effects: board features, Plane state changes, Discord channel provisioning. The gate gives a human (or a trusted automated signal) the chance to approve, reject, or modify a plan before any of that happens.

`correlationId` is the spine that connects every hop.

## 1. Overview

When Ava completes the `plan` skill, it returns immediately with `{ status: "pending_approval", correlationId }` rather than blocking. The plan state (PRD + review scores + metadata) is checkpointed to SQLite (`plans.db`, 7-day TTL). An `HITLRequest` is published to the bus, which routes it to the originating interface plugin for native rendering. A human responds, the interface plugin publishes an `HITLResponse`, and Workstacean routes to Ava's `plan_resume` skill to complete the flow.

The `auto` label on a Plane issue bypasses the gate entirely — see Section 6.

## 2. Message Types

### HITLRequest

Published by Ava to the `replyTopic` specified in the inbound BusMessage. The `correlationId` is the spine connecting all subsequent messages.

```typescript
type HITLRequest = {
  type: "HITLRequest"
  correlationId: string       // e.g. "plane-{issueId}" or "workstacean-{channel}"
  title: string               // short label for the approval prompt
  summary: string             // human-readable PRD summary
  avaVerdict: string          // Ava's operational review summary + score
  jonVerdict: string          // Jon's strategic review summary + score
  options: string[]           // available decisions, typically ["approve","reject","modify"]
  expiresAt: number           // Unix ms — HITLPlugin sweeps expired requests after 60s
  replyTopic: string          // topic to publish HITLResponse on
}
```

### HITLResponse

Published by any interface plugin (Discord, Plane reply, API) after a human decision. Workstacean routes this to `plan_resume`.

```typescript
type HITLResponse = {
  type: "HITLResponse"
  correlationId: string       // must match the HITLRequest correlationId
  decision: "approve" | "reject" | "modify"
  feedback?: string           // required when decision is "modify"; ignored otherwise
  decidedBy: string           // Discord user ID, "auto", or interface identifier
}
```

## 3. Plugin Architecture

`HITLPlugin` (`lib/plugins/hitl.ts`) is a Workstacean bus plugin that manages the in-memory state of pending approvals.

**Subscriptions:**
- `hitl.request.#` — stores the incoming HITLRequest in the pending Map; forwards to registered renderers
- `hitl.response.#` — validates correlationId exists in Map; removes from Map; publishes to the `replyTopic` from the original request

**In-memory Map:** keyed by `correlationId`, value is the full HITLRequest. The Map is not persisted — a workstacean restart clears it. If a restart happens while an approval is pending, the HITLResponse will still arrive but the lookup will miss and the response will be dropped. The PlanStore SQLite checkpoint is durable; the plan can be manually resumed by injecting an HITLResponse via `/publish`.

**Extension point — `registerHITLRenderer`:**

```typescript
registerHITLRenderer(interfaceName: string, handler: (request: HITLRequest) => Promise<void>)
```

Each interface plugin (Discord, etc.) registers a renderer on startup. When a new HITLRequest arrives, the plugin calls all registered renderers for interfaces that match the `source.interface` in the original BusMessage. This means adding a new rendering surface (Slack, voice, API webhook) requires only registering a renderer — no changes to HITLPlugin, the bus, or Ava.

**Expiry sweep:** runs every 60 seconds. Any HITLRequest where `expiresAt < Date.now()` is removed from the Map and a message is published to `hitl.expired.{correlationId}`. Interface plugins can subscribe to `hitl.expired.#` to clean up rendered prompts (e.g., disable Discord buttons).

## 4. Plan Flow

### plan skill (fire-and-forget)

Ava's `plan` skill is non-blocking from the caller's perspective:

```
1. Receive inbound message with skillHint "plan"
2. Return immediately: { status: "pending_approval", correlationId }
3. Async in background:
   a. Generate SPARC PRD (Specification, Pseudocode, Architecture, Refinement, Completion sections)
   b. Run antagonistic review:
      - Ava lens: operational feasibility, complexity, risk
      - Jon lens: strategic value, market positioning, ROI
      - Each produces a numeric score (0–10) and written verdict
   c. Checkpoint to PlanStore (SQLite, keyed by correlationId, 7-day TTL)
   d. Evaluate scores → HITL gate or auto-approve path
```

### plan_resume skill

Triggered when Workstacean receives an HITLResponse on the bus:

```
1. Restore PRD + review results from PlanStore by correlationId
2. Decision routing:
   approve → create board features (one feature per PRD section/milestone)
             stamp correlationId on each feature
             publish to plane.reply.{correlationId} → PlanePlugin syncs back
   reject  → archive plan in PlanStore (mark as rejected, no features created)
             post rejection notice to originating interface
   modify  → apply feedback to PRD (re-draft the affected sections)
             re-run antagonistic review with updated PRD
             re-emit HITLRequest (new expiresAt, same correlationId)
             loop restarts at the HITL gate
```

## 5. Decision Paths

| Decision | What happens |
|---|---|
| `approve` | Board features created, correlationId stamped, Plane issue → "In Progress" (if Plane-originated), summary comment posted to Plane issue |
| `reject` | Plan archived in PlanStore, no features created, rejection notice sent to originating channel |
| `modify` | PRD re-drafted with `feedback` applied, antagonistic review re-run, new HITLRequest emitted with same `correlationId` — the loop can repeat until approved or rejected |

For `modify`, the `feedback` field in HITLResponse is required. Ava treats it as a diff instruction: "make the scope smaller", "drop the third milestone", "reframe as an internal tool not a product". The re-drafted PRD replaces the checkpoint in PlanStore.

## 6. Auto-Approve

If the originating Plane issue has the `auto` label, the HITL gate is skipped entirely:

- Workstacean's `PlanePlugin` detects the `auto` label before publishing to the bus.
- The bus message payload carries `autoApprove: true`.
- Ava's `plan` skill checks this flag after completing the PRD + review.
- If set, it internally generates an HITLResponse with `decision: "approve"` and `decidedBy: "auto"` and calls `plan_resume` directly without publishing an HITLRequest.
- No approval prompt is rendered anywhere.

Use `auto` for trusted automation sources or low-stakes scaffolding tasks. Use `plan` for any idea that affects production infrastructure or significant engineering investment.

## 7. Expiry

The HITLPlugin expiry sweep runs every 60 seconds. When a request expires:

1. The entry is removed from the pending Map.
2. A message is published to `hitl.expired.{correlationId}`.
3. The plan remains in PlanStore — it is not automatically rejected. A late HITLResponse injected after expiry will not be routed (Map miss) but the plan can still be manually resumed.

The `expiresAt` value in HITLRequest is set by Ava at emit time. The default TTL for the pending Map entry is separate from the 7-day PlanStore TTL.

Interface plugins should subscribe to `hitl.expired.#` to handle expiry rendering (e.g., editing a Discord embed to show "Approval expired — re-trigger with /plan").

## 8. correlationId Conventions

| Origin | correlationId format | Example |
|---|---|---|
| Plane issue | `plane-{issueId}` | `plane-abc123de-f456-...` |
| Discord / other interface | `workstacean-{channelId}` | `workstacean-1469080556720623699` |

The `correlationId` is stable across the entire lifecycle: PRD generation, HITL request/response, plan_resume, and Plane sync-back all use the same value. It is stamped on every board feature created during `plan_resume` so the lineage is traceable.

## 9. Bus Topics

| Topic | Publisher | Subscriber | Description |
|-------|-----------|------------|-------------|
| `hitl.request.#` | Ava | HITLPlugin | Approval request after SPARC PRD + review |
| `hitl.response.#` | Interface plugin | HITLPlugin | Human decision |
| `hitl.pending.{correlationId}` | HITLPlugin | API callers | Unrouted requests (no matching interface) |
| `hitl.expired.{correlationId}` | HITLPlugin | Any | Request TTL exceeded — 60s sweep |

## 10. Interface Rendering

### Discord

The Discord plugin renders HITLRequests as message embeds with interactive buttons. The embed shows:
- `title` and `summary` from the request
- Ava and Jon verdict summaries with scores
- Approve / Reject / Modify buttons
- Expiry timestamp in the embed footer

Button interactions publish an HITLResponse to the bus with `decidedBy` set to the Discord user's ID.

### Plane reply

When the originating interface is Plane (issue with `plan` label), the HITLRequest routes to `plane.reply.{correlationId}`. The PlanePlugin renders this as a comment on the Plane issue asking for approval, and a subsequent issue update or comment triggers the HITLResponse.

### API polling

External services can poll `hitl.pending.#` by subscribing to the bus via the `/publish` endpoint or by calling `GET /api/hitl/{correlationId}` if the Workstacean HTTP API exposes it. This allows CI pipelines or other automated systems to act as approval sources without a UI.

### Adding a new renderer

```typescript
// In your interface plugin's init():
registerHITLRenderer("myinterface", async (request: HITLRequest) => {
  // render the approval prompt in your interface
  // when the user responds, publish:
  await bus.publish(`hitl.response.${request.correlationId}`, {
    type: "HITLResponse",
    correlationId: request.correlationId,
    decision: "approve",
    decidedBy: "user-identifier",
  })
})
```

## 11. Pending Request Lifecycle

1. `HITLRequest` arrives on `hitl.request.#` → stored in `pendingRequests` map.
2. Routed to interface. Interface renders and waits.
3. `HITLResponse` arrives on `hitl.response.#` → removed from map, forwarded to Ava.
4. If no response by `expiresAt` (checked every 60s) → removed from map, `hitl.expired.{correlationId}` published.

## 12. plan_resume A2A Call

The HITLPlugin calls Ava directly over A2A (JSON-RPC 2.0):

```json
{
  "jsonrpc": "2.0",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "HITL Decision: approve\nDecided by: chukz" }]
    },
    "contextId": "<correlationId>",
    "metadata": {
      "skillHint": "plan_resume",
      "hitlResponse": { "type": "hitl_response", "correlationId": "...", "decision": "approve", ... }
    }
  }
}
```

`contextId` matches the `correlationId` so Ava can look up the saved SQLite checkpoint. Timeout: 120s.

## 13. Design Principle

**The bus is dumb. Interface plugins own rendering. Ava owns plan state.**

- The bus routes messages — it has no opinion about format or display.
- Each interface plugin (Discord, Plane, API, future Slack/voice) handles its own rendering of the `HITLRequest` and collects the human response in whatever form is native to that interface.
- Ava stores plan state in SQLite between the `plan` and `plan_resume` calls — the HITL gate is just a pause point, not a re-computation.
- `correlationId` is set once (at inbound message creation) and threads through every hop without modification.

## 14. Testing

### Simulate an approval without a real Plane issue

Use the `/publish` endpoint on Workstacean (port 3000, Docker network only — reachable from `ava` host via `http://workstacean:3000` from containers on the shared network):

```bash
# Step 1: Inject a plan request to get a correlationId
curl -s -X POST http://ava:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "message.inbound.plane.issue.create",
    "payload": {
      "skillHint": "plan",
      "correlationId": "plane-test-approval-001",
      "content": "Add a weekly digest of merged PRs to the Discord dev channel",
      "source": { "interface": "plane", "channelId": "test" },
      "reply": { "topic": "plane.reply.plane-test-approval-001", "format": "text" },
      "autoApprove": false
    }
  }'

# Step 2: Wait for Ava to generate the PRD (watch logs)
docker logs -f workstacean | grep -E "(plan|HITL|PRD)"

# Step 3: Inject an approval once HITLRequest appears on the bus
curl -s -X POST http://ava:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "hitl.response.plane-test-approval-001",
    "payload": {
      "type": "HITLResponse",
      "correlationId": "plane-test-approval-001",
      "decision": "approve",
      "decidedBy": "test-injection"
    }
  }'
```

### Simulate a modify round

```bash
curl -s -X POST http://ava:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "hitl.response.plane-test-approval-001",
    "payload": {
      "type": "HITLResponse",
      "correlationId": "plane-test-approval-001",
      "decision": "modify",
      "feedback": "Scope it down — weekly only, no per-PR detail, just a count + link",
      "decidedBy": "test-injection"
    }
  }'
# Ava will re-draft the PRD and emit a new HITLRequest with the same correlationId
```

### Simulate a rejection

```bash
curl -s -X POST http://ava:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "hitl.response.plane-test-approval-001",
    "payload": {
      "type": "HITLResponse",
      "correlationId": "plane-test-approval-001",
      "decision": "reject",
      "decidedBy": "test-injection"
    }
  }'
```

### Verify PlanStore checkpoint

The SQLite database is at `/data/plans.db` inside the `workstacean` container:

```bash
docker exec workstacean sqlite3 /data/plans.db \
  "SELECT correlationId, status, createdAt FROM plans ORDER BY createdAt DESC LIMIT 5;"
```

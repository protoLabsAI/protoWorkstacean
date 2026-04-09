---
title: HITL — Human-in-the-Loop Gate
---

HITL is the approval gate that sits between an autonomous decision and its permanent side effects. It exists because some actions — board feature creation, infrastructure changes, high-cost agent runs — should not happen without a human in the loop.

`correlationId` is the spine that connects every hop.

---

## Overview

When any system component needs a human decision, it publishes an `HITLRequest` to the bus. `HITLPlugin` routes it to the registered renderer for the originating interface (Discord, Plane, Signal, API). A human responds. The interface plugin publishes an `HITLResponse`. `HITLPlugin` routes the response back to the requester via `replyTopic` (bus) and, if configured, calls the plan_resume agent via A2A.

Two types of HITL flow coexist on the same infrastructure:

| Flow | Publisher | Callback path | Example |
|---|---|---|---|
| **Plan gate** | Ava | plan_resume A2A → Ava resumes feature creation | New project plan after SPARC PRD |
| **Operational gate** | Any plugin | `replyTopic` on the bus | Budget L3 escalation, goal violation, queue saturation |

Both use the same `HITLRequest`/`HITLResponse` shapes, the same topic conventions, and the same renderer interface.

---

## Message types

### HITLRequest

```typescript
interface HITLRequest {
  type: "hitl_request";
  correlationId: string;    // spine — set at message origin, never changes
  title: string;            // short label for the approval prompt
  summary: string;          // human-readable context (markdown ok)
  options: string[];        // available decisions: ["approve","reject","modify"]
  expiresAt: string;        // ISO timestamp — HITLPlugin sweeps expired entries every 60s
  replyTopic: string;       // where to publish HITLResponse on the bus
  sourceMeta?: {            // originating interface — used to pick the renderer
    interface: string;      // "discord" | "plane" | "signal" | "slack" | "api"
    channelId?: string;
    userId?: string;
  };
  // ── Plan gate fields (populated by Ava) ────────────────────────────────────
  avaVerdict?: { score: number; concerns: string[]; verdict: string };
  jonVerdict?: { score: number; concerns: string[]; verdict: string };
  // ── Operational gate fields (populated by BudgetPlugin L3, etc.) ───────────
  escalation_reason?: string;
  escalationContext?: {
    estimatedCost: number;
    maxCost: number;
    tier: string;
    budgetState: {
      remainingProjectBudget: number;
      remainingDailyBudget: number;
      projectBudgetRatio: number;
      dailyBudgetRatio: number;
    };
  };
}
```

### HITLResponse

```typescript
interface HITLResponse {
  type: "hitl_response";
  correlationId: string;                         // must match the HITLRequest
  decision: "approve" | "reject" | "modify";
  feedback?: string;                             // required when decision is "modify"
  decidedBy: string;                             // Discord user ID, "auto", agent name, etc.
}
```

---

## Bus topics

| Topic | Publisher | Subscriber | When |
|---|---|---|---|
| `hitl.request.{ns}.{correlationId}` | Any plugin or agent | HITLPlugin | New approval needed |
| `hitl.response.{ns}.{correlationId}` | Interface plugin | HITLPlugin | Human decision collected |
| `hitl.pending.{correlationId}` | HITLPlugin | API pollers | No registered renderer for the interface |
| `hitl.expired.{correlationId}` | HITLPlugin | Registered renderers | TTL exceeded (60s sweep) |

`{ns}` is a namespace segment from the publisher (e.g. `budget`, `plan`, `goal`). It scopes the topic so different flows don't interfere.

---

## Response routing

When a renderer publishes an `HITLResponse` to `request.replyTopic` (a `hitl.response.*` topic):

1. **Bus delivery** — the message lands on `request.replyTopic`. Any plugin that subscribed to that topic receives it automatically through pub/sub. No re-routing by HITLPlugin is needed — the bus handles it.

2. **A2A plan_resume** — HITLPlugin subscribes to `hitl.response.#` and intercepts every response. If `workspace/agents.yaml` contains an agent with the `plan_resume` skill (Ava), HITLPlugin calls that agent via JSON-RPC 2.0. This is Ava's plan gate path — Ava is an external service that doesn't subscribe to the bus directly.

Both paths are triggered by the single publish from the renderer. The A2A call is a no-op if no plan_resume agent is configured.

> **Convention:** `request.replyTopic` is always in the `hitl.response.#` namespace so HITLPlugin can intercept it. Renderers should publish to `request.replyTopic` directly rather than constructing the topic themselves.

---

## The renderer interface

Every channel plugin that wants to render HITL approvals implements two methods:

```typescript
interface HITLRenderer {
  /**
   * Called when a new HITLRequest arrives for this interface.
   * Render the approval UI on your platform.
   * When the user responds, publish an HITLResponse to the bus:
   *
   *   bus.publish(`hitl.response.${ns}.${request.correlationId}`, { ... })
   */
  render(request: HITLRequest, bus: EventBus): Promise<void>;

  /**
   * Called when the request expires before a decision is made.
   * Clean up the rendered UI (disable buttons, post "timed out", etc.).
   */
  onExpired?(request: HITLRequest, bus: EventBus): Promise<void>;
}
```

Register during `install()`:

```typescript
// In your plugin's install():
hitlPlugin.registerRenderer("myplatform", {
  async render(request, bus) {
    // post approval UI to your platform
    // collect decision
    // publish hitl.response.*
  },
  async onExpired(request, bus) {
    // disable buttons, post expiry notice
  },
});
```

`HITLPlugin` resolves the renderer from `request.sourceMeta.interface`. If no renderer is registered for the interface, the request falls back to `hitl.pending.{correlationId}` for API polling.

---

## Publishing a HITL request

Any plugin can gate on human approval:

```typescript
const correlationId = crypto.randomUUID();

bus.publish(`hitl.request.budget.${correlationId}`, {
  id: crypto.randomUUID(),
  correlationId,
  topic: `hitl.request.budget.${correlationId}`,
  timestamp: Date.now(),
  payload: {
    type: "hitl_request",
    correlationId,
    title: "Budget approval required",
    summary: `Agent \`frank\` wants to run a $4.20 operation.\n\nEstimated: **$4.20** | Budget remaining: **$6.40**`,
    options: ["approve", "reject"],
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    replyTopic: `hitl.response.budget.${correlationId}`,
    sourceMeta: originalMsg.source,
    escalation_reason: "Estimated cost $4.20 exceeds L2 threshold ($5.00 with <10% remaining)",
  },
});

// Subscribe to the response:
bus.subscribe(`hitl.response.budget.${correlationId}`, "budget-plugin", (msg) => {
  const resp = msg.payload as HITLResponse;
  if (resp.decision === "approve") {
    // proceed
  } else {
    // abort, notify
  }
});
```

---

## Discord renderer (reference implementation)

Discord is the reference HITL interface. It renders requests as embeds with interactive buttons and collects decisions natively.

**What it renders:**

```
┌─────────────────────────────────────┐
│ 🔐  Budget approval required        │
│                                     │
│ Agent `frank` wants to run a $4.20  │
│ operation.                          │
│                                     │
│ Estimated: $4.20 | Remaining: $6.40 │
│                                     │
│ [✅ Approve]  [❌ Reject]            │
│                                     │
│ Expires in 30 minutes               │
└─────────────────────────────────────┘
```

**How it works:**

1. Registered renderer's `render()` posts the embed with buttons to `sourceMeta.channelId`
2. `DiscordPlugin` captures the button interaction
3. On click: publishes `HITLResponse` to the bus with `decidedBy: interaction.user.id`
4. `onExpired()`: edits the embed to show "Approval expired — re-trigger if still needed", disables buttons

**Implementing it:**

```typescript
// In DiscordPlugin.install():
const renderer: HITLRenderer = {
  async render(request, bus) {
    const embed = buildHITLEmbed(request);
    const buttons = buildHITLButtons(request.options, request.correlationId);
    const channelId = request.sourceMeta?.channelId;
    if (!channelId) return;

    const ch = client.channels.cache.get(channelId) as TextChannel;
    const msg = await ch.send({ embeds: [embed], components: [buttons] });

    // Track message for expiry cleanup
    pendingHITLMessages.set(request.correlationId, msg);
  },

  async onExpired(request, bus) {
    const msg = pendingHITLMessages.get(request.correlationId);
    if (!msg) return;
    pendingHITLMessages.delete(request.correlationId);
    await msg.edit({
      embeds: [expiredEmbed(request)],
      components: [], // removes buttons
    });
  },
};

hitlPlugin.registerRenderer("discord", renderer);
```

Button interaction handler (in `Events.InteractionCreate`):

```typescript
if (interaction.isButton() && interaction.customId.startsWith("hitl:")) {
  const [, decision, correlationId] = interaction.customId.split(":");
  await interaction.deferUpdate();

  // Use the stored replyTopic from the original request (set during render())
  const entry = pendingHITLMessages.get(correlationId);
  const replyTopic = entry?.replyTopic
    ?? `hitl.response.${correlationId.split("-")[0]}.${correlationId}`;

  bus.publish(replyTopic, {
    id: crypto.randomUUID(),
    correlationId,
    topic: replyTopic,
    timestamp: Date.now(),
    payload: {
      type: "hitl_response",
      correlationId,
      decision: decision as "approve" | "reject" | "modify",
      decidedBy: interaction.user.id,
    },
  });

  if (entry) pendingHITLMessages.delete(correlationId);
  await interaction.message.edit({ components: [] }); // disable buttons after click
}
```

---

## Plan gate flow (Ava)

The plan gate is one specific use of HITL, triggered after Ava generates a SPARC PRD and antagonistic review.

```
1. Inbound message with skillHint "plan"
2. Ava generates SPARC PRD + antagonistic review
   - Ava verdict: operational feasibility, risk score
   - Jon verdict: strategic value, ROI score
3. Ava checkpoints plan to PlanStore (SQLite, keyed by correlationId, 7-day TTL)
4. Ava publishes hitl.request.plan.{correlationId} with replyTopic
5. HITLPlugin routes to registered renderer (Discord embed shows PRD summary + verdicts)
6. Human approves/rejects/modifies
7. Renderer publishes hitl.response.plan.{correlationId}
8. HITLPlugin:
   a. Publishes response to replyTopic (bus)
   b. Calls plan_resume via A2A → Ava restores checkpoint, executes decision
```

### plan_resume decisions

| Decision | What happens |
|---|---|
| `approve` | Board features created, Plane issue → "In Progress", summary comment posted |
| `reject` | Plan archived in PlanStore, rejection notice sent to originating channel |
| `modify` | PRD re-drafted with `feedback` applied, antagonistic review re-run, new `HITLRequest` emitted with same `correlationId` |

### Auto-approve

Plane issues with the `auto` label skip the gate entirely. `PlanePlugin` sets `autoApprove: true` in the bus message. Ava internally generates `HITLResponse { decision: "approve", decidedBy: "auto" }` and calls `plan_resume` directly.

---

## correlationId conventions

| Origin | Format | Example |
|---|---|---|
| Plane issue | `plane-{issueId}` | `plane-abc123de-f456-...` |
| Discord | `discord-{channelId}-{uuid8}` | `discord-1469080556720623699-a1b2c3d4` |
| Budget | `budget-{requestId}` | `budget-3f8a12...` |
| Goal violation | `goal-{goalId}-{uuid8}` | `goal-flow.efficiency_healthy-9f2b1c` |

The `correlationId` is stable for the entire lifecycle. Every bus message, A2A call, and database record in the flow carries the same value.

---

## Expiry

HITLPlugin sweeps pending requests every 60s. When a request expires:

1. Removed from in-memory Map
2. `hitl.expired.{correlationId}` published (original request in payload)
3. Registered renderer's `onExpired()` is called

The plan remains in PlanStore after expiry — it is not automatically rejected. A late `HITLResponse` injected after expiry will not be routed (Map miss). To manually resume an expired plan, inject an `HITLResponse` via `POST /publish`.

---

## Adding HITL to a new channel

Channel devs need three things:

**1. Implement `HITLRenderer`:**
```typescript
const renderer: HITLRenderer = {
  async render(request, bus) { /* post approval UI */ },
  async onExpired(request, bus) { /* clean up */ },
};
```

**2. Register it during `install()`:**
```typescript
hitlPlugin.registerRenderer("myplatform", renderer);
```

The `"myplatform"` name must match what your plugin sets in `BusMessage.source.interface`. `HITLPlugin` uses this to dispatch.

**3. Collect the decision and publish `HITLResponse` to `request.replyTopic`:**
```typescript
bus.publish(request.replyTopic, {
  id: crypto.randomUUID(),
  correlationId: request.correlationId,
  topic: request.replyTopic,
  timestamp: Date.now(),
  payload: {
    type: "hitl_response",
    correlationId: request.correlationId,
    decision: "approve",
    decidedBy: "user-identifier",
  },
});
```

That's it. The rest — routing to `replyTopic`, A2A callback to Ava — is handled by `HITLPlugin`.

---

## Testing

### Simulate an approval

```bash
# Step 1: trigger a plan request
curl -s -X POST http://localhost:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "message.inbound.plane.issue.created",
    "payload": {
      "skillHint": "plan",
      "correlationId": "plane-test-001",
      "content": "Add a weekly digest of merged PRs to the Discord dev channel",
      "source": { "interface": "plane", "channelId": "test" },
      "reply": { "topic": "plane.reply.plane-test-001" },
      "autoApprove": false
    }
  }'

# Step 2: watch logs for HITLRequest
# docker logs -f workstacean | grep hitl

# Step 3: inject an approval
curl -s -X POST http://localhost:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "hitl.response.plan.plane-test-001",
    "payload": {
      "type": "hitl_response",
      "correlationId": "plane-test-001",
      "decision": "approve",
      "decidedBy": "test-injection"
    }
  }'
```

### Simulate a modify round

```bash
curl -s -X POST http://localhost:3000/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "hitl.response.plan.plane-test-001",
    "payload": {
      "type": "hitl_response",
      "correlationId": "plane-test-001",
      "decision": "modify",
      "feedback": "Scope it down — weekly only, no per-PR detail",
      "decidedBy": "test-injection"
    }
  }'
```

### Verify PlanStore

```bash
docker exec workstacean sqlite3 /data/plans.db \
  "SELECT correlationId, status, createdAt FROM plans ORDER BY createdAt DESC LIMIT 5;"
```

### Poll pending requests (API mode)

If no renderer is registered for the interface, requests land on `hitl.pending.{correlationId}`. Subscribe via the bus or poll:

```bash
curl http://localhost:3000/api/hitl/pending
```

---

## Design principles

**The bus routes. Interface plugins render. Requesters own their response logic.**

- `HITLPlugin` is a router — it stores state, dispatches to renderers, and routes responses. It has no opinion on format, display, or what to do with the decision.
- Each interface plugin (Discord, Plane, Signal, Slack, API) owns rendering for its platform.
- The requester (BudgetPlugin, GoalEvaluator, Ava) owns what to do with the response — HITL doesn't know or care.
- `correlationId` is immutable across the entire lifecycle.

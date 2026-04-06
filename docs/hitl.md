# HITL — Human-in-the-Loop Gate

The HITL system routes approval requests from Ava's `plan` skill to the interface that originated the idea, then routes the human's decision back to Ava's `plan_resume` skill to continue.

`correlationId` is the spine that connects every hop.

## Flow

```
1. Any interface plugin publishes a BusMessage
   → source: { interface: "discord" | "plane" | "api" | ..., channelId, userId }
   → reply: { topic: "message.outbound.discord.push.{channelId}", format: "embed" }

2. A2APlugin routes to Ava (skillHint: "plan")
   → Ava generates SPARC PRD
   → Antagonistic review: Ava (operational lens) × Jon (strategic lens)
   → Both scores > 4.0 → auto-approved, features created immediately
   → Either score ≤ 4.0 → Ava publishes HITLRequest to hitl.request.{correlationId}

3. HITLPlugin routes the request to the correct interface
   → Discord  → message.outbound.discord.push.{channelId}  (embed with buttons)
   → API      → hitl.pending.{correlationId}               (callers poll)
   → unknown  → hitl.pending.{correlationId}               (fallback)

4. Interface plugin renders natively and waits for human input
   → User approves / rejects / requests modification

5. Interface plugin publishes HITLResponse to hitl.response.{correlationId}

6. HITLPlugin routes response to Ava (plan_resume)
   → A2A call: method "message/send", contextId = correlationId, metadata.skillHint = "plan_resume"
   → Ava restores plan state from SQLite checkpoint (plans.db, 7-day TTL)
   → Creates project + board features, stamps correlationId on all artifacts
   → Publishes reply to plane.reply.{issueId} (if Plane-originated)
     → PlanePlugin PATCHes issue state → Done + adds completion comment
```

## Key Types

Defined in `lib/types.ts`:

```ts
interface HITLRequest {
  type: "hitl_request";
  correlationId: string;
  title: string;
  summary: string;
  avaVerdict?:  { score: number; concerns: string[]; verdict: string };
  jonVerdict?:  { score: number; concerns: string[]; verdict: string };
  options: string[];   // ["approve", "reject", "modify"]
  expiresAt: string;   // ISO timestamp
  replyTopic: string;  // where to publish HITLResponse
  sourceMeta?: BusMessage["source"];
}

interface HITLResponse {
  type: "hitl_response";
  correlationId: string;
  decision: "approve" | "reject" | "modify";
  feedback?: string;
  decidedBy: string;
}
```

`sourceMeta` carries the originating interface through so the HITLPlugin knows where to send the request without the agent needing to know anything about rendering.

## Bus Topics

| Topic | Publisher | Subscriber | Description |
|-------|-----------|------------|-------------|
| `hitl.request.#` | Ava | HITLPlugin | Approval request after SPARC PRD + review |
| `hitl.response.#` | Interface plugin | HITLPlugin | Human decision |
| `hitl.pending.{correlationId}` | HITLPlugin | API callers | Unrouted requests (no matching interface) |
| `hitl.expired.{correlationId}` | HITLPlugin | Any | Request TTL exceeded — 60s sweep |

## Pending Request Lifecycle

1. `HITLRequest` arrives on `hitl.request.#` → stored in `pendingRequests` map.
2. Routed to interface. Interface renders and waits.
3. `HITLResponse` arrives on `hitl.response.#` → removed from map, forwarded to Ava.
4. If no response by `expiresAt` (checked every 60s) → removed from map, `hitl.expired.{correlationId}` published.

## Adding a New Interface

The HITLPlugin is extensible without modifying its source. Any plugin can register a custom renderer:

```ts
import { registerInterface, registerHITLRenderer } from "../plugins/hitl.ts";

// Option A: register a topic router — HITLPlugin publishes to the returned topic
registerInterface("slack", (req: HITLRequest) => {
  return `message.outbound.slack.push.${req.sourceMeta?.channelId}`;
});

// Option B: register an inline renderer — handler does its own publishing
registerHITLRenderer("voice", (req: HITLRequest) => {
  // synthesize speech, wait for yes/no, publish HITLResponse directly
});
```

The Workstacean bus itself is not modified. Ava and the plan checkpoint are not modified. Only the new interface plugin is added.

## plan_resume A2A Call

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

## Design Principle

**The bus is dumb. Interface plugins own rendering. Ava owns plan state.**

- The bus routes messages — it has no opinion about format or display.
- Each interface plugin (Discord, Plane, API, future Slack/voice) handles its own rendering of the `HITLRequest` and collects the human response in whatever form is native to that interface.
- Ava stores plan state in SQLite between the `plan` and `plan_resume` calls — the HITL gate is just a pause point, not a re-computation.
- `correlationId` is set once (at inbound message creation) and threads through every hop without modification.

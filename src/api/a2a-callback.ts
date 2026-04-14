/**
 * A2A push notification callback — webhook endpoint for long-running tasks.
 *
 * External agents POST Task snapshots here when they reach terminal state
 * (or at configurable checkpoints). This closes the loop without requiring
 * workstacean to hold an HTTP connection open for minutes.
 *
 * Flow:
 *   1. A2AExecutor registers a PushNotificationConfig with the agent when
 *      dispatching a task: { url: WORKSTACEAN_BASE_URL/api/a2a/callback/{taskId},
 *      token: random-per-task-secret }
 *   2. Agent POSTs Task JSON here with Bearer token
 *   3. We verify token, look up task in TaskTracker, publish response to
 *      original replyTopic
 *
 * Security: token is a per-task HMAC-unguessable shared secret. Without the
 * right token the request is dropped. Broken callbacks don't surface to agents
 * (they're not expected to retry here).
 */

import type { Route, ApiContext } from "./types.ts";
import type { TaskTracker } from "../executor/task-tracker.ts";

export function createRoutes(tracker: TaskTracker, _ctx: ApiContext): Route[] {
  return [
    {
      method: "POST",
      path: "/api/a2a/callback/:taskId",
      handler: async (req, params) => {
        const taskId = params.taskId;
        if (!taskId) {
          return Response.json({ success: false, error: "taskId required" }, { status: 400 });
        }

        // Token from Authorization: Bearer <token> OR X-A2A-Notification-Token header.
        // A2A spec uses X-A2A-Notification-Token for the unauthenticated case.
        const authHeader = req.headers.get("authorization") ?? "";
        const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        const notifToken = req.headers.get("x-a2a-notification-token") ?? "";
        const providedToken = bearer || notifToken;

        const tracked = tracker.getAll().find(t => t.taskId === taskId);
        if (!tracked) {
          return Response.json({ success: false, error: "Unknown taskId" }, { status: 404 });
        }

        const expectedToken = tracker.getCallbackToken(tracked.correlationId);
        if (!expectedToken || providedToken !== expectedToken) {
          return Response.json({ success: false, error: "Invalid notification token" }, { status: 401 });
        }

        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });
        }

        // The A2A spec says the webhook receives the full Task object (not a delta).
        // We route it through the tracker so terminal-state handling is identical
        // to the polling path.
        tracker.handleCallback(tracked.correlationId, body);

        return Response.json({ success: true });
      },
    },
  ];
}

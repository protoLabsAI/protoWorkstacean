/**
 * GET /api/bus/history — replay slice of the in-memory bus history buffer.
 *
 * Query params:
 *   correlationId  — return every message whose correlationId === this value,
 *                    oldest first. Used by the dashboard's
 *                    /system/trace/:correlationId waterfall (D1).
 *   limit          — when no correlationId is given, return the N most-recent
 *                    messages across all correlations. Defaults to 200,
 *                    capped at 1000 so a curl dump can't OOM the dashboard.
 *
 * The buffer is a 10k-event ring with 30-min TTL (see history-recorder.ts).
 * Returns 503 if no recorder is wired — never falls back to "empty array
 * looks like success" because callers (dashboard waterfall) need to
 * distinguish "no history" from "feature disabled".
 */

import type { Route, ApiContext } from "./types.ts";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export function createRoutes(ctx: ApiContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/bus/history",
      handler: (req) => {
        if (!ctx.busHistory) {
          return Response.json(
            { success: false, error: "bus-history-recorder not installed" },
            { status: 503 },
          );
        }

        const url = new URL(req.url);
        const correlationId = url.searchParams.get("correlationId");

        if (correlationId) {
          const messages = ctx.busHistory.byCorrelationId(correlationId);
          return Response.json({
            success: true,
            data: {
              correlationId,
              count: messages.length,
              messages,
              stats: ctx.busHistory.stats(),
            },
          });
        }

        const rawLimit = url.searchParams.get("limit");
        const limit = clampLimit(rawLimit);
        const messages = ctx.busHistory.recent(limit);
        return Response.json({
          success: true,
          data: {
            count: messages.length,
            messages,
            stats: ctx.busHistory.stats(),
          },
        });
      },
    },
  ];
}

function clampLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

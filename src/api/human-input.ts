/**
 * Human-input round-trip — the A2A `input-required` path.
 *
 * When an in-process agent (Ava) calls its `ask_human` tool mid-task, it needs
 * an answer from whoever invoked it over A2A (e.g. ORBIS). Ava's run is a single
 * blocking `executor.invoke()` with no LangGraph checkpoint, so we can't pause
 * the graph and resume it across A2A turns. Instead the tool BLOCKS on this
 * endpoint for the duration of one streamed turn, while the SSE heartbeat
 * (see a2a-server.ts) keeps the caller's connection alive.
 *
 *   ask_human tool ──POST /api/agent/ask-human {correlationId, question}──▶
 *     publish agent.input.request.{correlationId} {requestId, question}
 *       ──▶ BusAgentExecutor (handling that A2A task) emits an `input-required`
 *           status-update carrying the question + requestId on the open stream
 *     … handler awaits the answer (TTL) …
 *   caller ──POST /api/a2a/input {requestId, answer}──▶
 *     resolve the pending request (+ publish agent.input.response.{requestId})
 *       ──▶ ask-human handler returns {answer} ──▶ tool returns it to the agent
 *
 * Pending state is in-memory by design: the answer feeds a blocked in-process
 * run that cannot survive a restart, so durable persistence would buy nothing.
 */

import type { Route, ApiContext } from "./types.ts";

interface PendingInput {
  requestId: string;
  correlationId: string;
  question: string;
  createdAt: number;
  resolve: (answer: string | null) => void;
}

const pending = new Map<string, PendingInput>();

/** Snapshot of currently-waiting human-input requests (for /api/hitl/pending). */
export function getPendingHumanInput(): Array<{ requestId: string; correlationId: string; question: string; createdAt: number }> {
  return [...pending.values()].map(p => ({
    requestId: p.requestId,
    correlationId: p.correlationId,
    question: p.question,
    createdAt: p.createdAt,
  }));
}

// Cap the wait under the in-process tool HttpClient's 120s ceiling so the
// endpoint always returns to the agent before its HTTP call aborts. A2A callers
// answer programmatically (seconds), so this window is generous. Read per-call
// so the env override (A2A_INPUT_REQUIRED_TTL_MS) takes effect without a restart.
function ttlMs(): number {
  return Number(process.env.A2A_INPUT_REQUIRED_TTL_MS) || 110_000;
}

export function createRoutes(ctx: ApiContext): Route[] {
  const authorized = (req: Request): boolean => {
    if (!ctx.apiKey) return true;
    if (req.headers.get("x-api-key") === ctx.apiKey) return true;
    return req.headers.get("authorization") === `Bearer ${ctx.apiKey}`;
  };

  return [
    {
      // Internal — called by an agent's `ask_human` tool. Blocks until the
      // caller answers (via /api/a2a/input) or the wait window elapses.
      method: "POST",
      path: "/api/agent/ask-human",
      handler: async (req) => {
        let body: { correlationId?: string; question?: string };
        try { body = (await req.json()) as typeof body; }
        catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

        if (!body.correlationId || !body.question) {
          return Response.json({ success: false, error: "correlationId and question are required" }, { status: 400 });
        }

        const requestId = crypto.randomUUID();
        const { correlationId, question } = body;
        const requestTopic = `agent.input.request.${correlationId}`;

        // Announce the request so the A2A server bridging this task surfaces an
        // input-required status-update (with requestId + question) to the caller.
        ctx.bus.publish(requestTopic, {
          id: crypto.randomUUID(),
          correlationId,
          topic: requestTopic,
          timestamp: Date.now(),
          payload: { requestId, question },
          source: { interface: "api" },
        });

        const answer = await new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(requestId);
            resolve(null);
          }, ttlMs());
          pending.set(requestId, {
            requestId,
            correlationId,
            question,
            createdAt: Date.now(),
            resolve: (a) => {
              clearTimeout(timer);
              pending.delete(requestId);
              resolve(a);
            },
          });
        });

        if (answer === null) {
          return Response.json({ success: true, timedOut: true, answer: null });
        }
        return Response.json({ success: true, answer });
      },
    },
    {
      // Caller-facing — the A2A caller answers a pending input-required request.
      method: "POST",
      path: "/api/a2a/input",
      handler: async (req) => {
        if (!authorized(req)) {
          return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }

        let body: { requestId?: string; answer?: string };
        try { body = (await req.json()) as typeof body; }
        catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

        if (!body.requestId || typeof body.answer !== "string") {
          return Response.json({ success: false, error: "requestId and answer (string) are required" }, { status: 400 });
        }

        const p = pending.get(body.requestId);
        if (!p) {
          return Response.json(
            { success: false, error: "No pending request for that requestId (expired or already answered)" },
            { status: 404 },
          );
        }

        // Surface the answer on the bus for observability/trace, then resolve
        // the blocked ask-human handler.
        const responseTopic = `agent.input.response.${body.requestId}`;
        ctx.bus.publish(responseTopic, {
          id: crypto.randomUUID(),
          correlationId: p.correlationId,
          topic: responseTopic,
          timestamp: Date.now(),
          payload: { requestId: body.requestId, answer: body.answer },
          source: { interface: "a2a" },
        });
        p.resolve(body.answer);

        return Response.json({ success: true });
      },
    },
  ];
}

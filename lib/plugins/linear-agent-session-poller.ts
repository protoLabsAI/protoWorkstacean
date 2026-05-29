/**
 * LinearAgentSessionPoller — recovers Linear agent sessions that Linear failed
 * to deliver a webhook for.
 *
 * Linear's agent-session webhook delivery is intermittent: it creates the
 * session reliably (queryable via the API) but often never POSTs the
 * `agent_session.created` / `.prompted` webhook to us, so the session times out
 * to `stale` ("Ava did not respond"). The webhook path is unchanged and still
 * the fast path when it works; this poller is the safety net.
 *
 * Design — poll ONLY `stale` sessions:
 *   - A working webhook never leaves a session `stale` (the agent responds, so
 *     it goes active/complete). So polling `stale` can't double-post against a
 *     working delivery — it only picks up the ones that fell through.
 *   - For each stale session not already handled (keyed by id+updatedAt so a
 *     fresh prompt that re-stales gets re-picked), publish the same
 *     `message.inbound.linear.agent_session.created` event the webhook would
 *     have, with the reply.topic set — the existing router → linear_agent_respond
 *     → thought-ack + response-activity pipeline does the rest. Per Linear's
 *     docs, a stale session is recoverable by sending an activity.
 */

import { join } from "node:path";
import type { EventBus, Plugin } from "../types.ts";
import { LinearAgentActivityClient } from "../linear/agent-activity-client.ts";
import { getLinearAvaTokenManager } from "../linear/ava-oauth-token-manager.ts";

const GRAPHQL_URL = "https://api.linear.app/graphql";
const POLL_INTERVAL_MS = 20_000;
/** Drop handled keys older than this so re-stale of a fresh prompt re-fires. */
const HANDLED_TTL_MS = 10 * 60 * 1000;

interface StaleSession {
  id: string;
  updatedAt: string;
  issueId?: string;
  issueIdentifier?: string;
}

const QUERY =
  "{ agentSessions(first: 25) { nodes { id status updatedAt issue { id identifier } } } }";

/** Pull `stale` sessions from Linear — pure transport, exported for testing. */
export async function fetchStaleSessions(apiKey: string, fetchImpl: typeof fetch): Promise<StaleSession[]> {
  const res = await fetchImpl(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`agentSessions query HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { agentSessions?: { nodes?: Array<{ id: string; status: string; updatedAt: string; issue?: { id?: string; identifier?: string } }> } };
    errors?: Array<{ message?: string }>;
  };
  if (json.errors?.length) throw new Error(`agentSessions query error: ${json.errors.map(e => e.message).join("; ")}`);
  return (json.data?.agentSessions?.nodes ?? [])
    .filter(n => n.status === "stale")
    .map(n => ({ id: n.id, updatedAt: n.updatedAt, issueId: n.issue?.id, issueIdentifier: n.issue?.identifier }));
}

export class LinearAgentSessionPoller implements Plugin {
  readonly name = "linear-agent-session-poller";
  readonly description = "Recovers stale Linear agent sessions the webhook never delivered";
  readonly capabilities = ["linear-agent-session-recovery"];
  readonly publishes = ["message.inbound.linear.agent_session.created"];

  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  /** key = `${sessionId}:${updatedAt}` → handled-at ms. */
  private handled = new Map<string, number>();
  /** Gate: only recover a stale session if its issue is assigned to Ava. When
   *  undefined (Ava OAuth not configured), gating is disabled — recover all. */
  private readonly assignedToAva?: (issueId: string) => Promise<boolean>;

  constructor(opts: { apiKey?: string; fetchImpl?: typeof fetch; intervalMs?: number; assignedToAva?: (issueId: string) => Promise<boolean> } = {}) {
    this.apiKey = opts.apiKey ?? process.env.LINEAR_API_KEY;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
    if (opts.assignedToAva) {
      this.assignedToAva = opts.assignedToAva;
    } else {
      const dataDir = process.env.DATA_DIR || join(process.cwd(), "data");
      const tokenManager = getLinearAvaTokenManager(dataDir);
      if (tokenManager.isConfigured()) {
        const client = new LinearAgentActivityClient(tokenManager);
        this.assignedToAva = (issueId) => client.isAssignedToAva(issueId);
      }
    }
  }

  install(bus: EventBus): void {
    if (!this.apiKey) {
      console.warn("[linear-session-poller] LINEAR_API_KEY not set — stale-session recovery disabled");
      return;
    }
    this.timer = setInterval(() => void this._poll(bus), this.intervalMs);
    this.timer.unref?.();
    void this._poll(bus); // immediate first sweep
    console.log(`[linear-session-poller] recovering stale agent sessions every ${this.intervalMs / 1000}s`);
  }

  uninstall(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep — exported semantics tested via _poll with injected bus/fetch. */
  async _poll(bus: EventBus): Promise<void> {
    let sessions: StaleSession[];
    try {
      sessions = await fetchStaleSessions(this.apiKey!, this.fetchImpl);
    } catch (err) {
      console.error(`[linear-session-poller] poll failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this._prune();
    for (const s of sessions) {
      const key = `${s.id}:${s.updatedAt}`;
      if (this.handled.has(key)) continue;

      // Only recover sessions for issues assigned to Ava — a stale session on
      // an unassigned/abandoned issue is noise, not a missed assignment.
      if (this.assignedToAva) {
        if (!s.issueId) continue; // no issue → nothing to verify; leave it
        let assigned: boolean;
        try {
          assigned = await this.assignedToAva(s.issueId);
        } catch (err) {
          // Transient/auth error — don't mark handled, retry next sweep.
          console.warn(`[linear-session-poller] assignee check failed for session ${s.id} — retry next sweep: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (!assigned) {
          this.handled.set(key, Date.now()); // mark so we don't re-check this stale state every sweep
          console.log(`[linear-session-poller] stale session ${s.id}${s.issueIdentifier ? ` (${s.issueIdentifier})` : ""} not assigned to Ava — skipping recovery`);
          continue;
        }
      }

      this.handled.set(key, Date.now());
      bus.publish("message.inbound.linear.agent_session.created", {
        id: crypto.randomUUID(),
        correlationId: s.id,
        topic: "message.inbound.linear.agent_session.created",
        timestamp: Date.now(),
        payload: {
          // Same shape the webhook publishes — routes to Ava's Linear handler.
          skillHint: "linear_agent_respond",
          action: "created",
          sessionId: s.id,
          issueId: s.issueId,
          agentSession: { id: s.id, issueId: s.issueId },
          agentActivity: {},
          recoveredViaPoll: true,
        },
        reply: { topic: `linear.agent_activity.${s.id}`, format: "markdown" as const },
      });
      console.log(`[linear-session-poller] recovered stale session ${s.id}${s.issueIdentifier ? ` (${s.issueIdentifier})` : ""} → dispatched to Ava`);
    }
  }

  private _prune(): void {
    const cutoff = Date.now() - HANDLED_TTL_MS;
    for (const [k, t] of this.handled) if (t < cutoff) this.handled.delete(k);
  }
}

/**
 * LinearAgentActivityClient — posts agent activities into a Linear agent
 * session AS Ava, using her actor=app OAuth token (not the operator's personal
 * LINEAR_API_KEY). This is what makes a session reply show up authored by the
 * agent in Linear's native agent-session thread.
 *
 * Linear marks a session unresponsive if the agent doesn't emit an activity
 * within 10s of `agent_session.created`, so the thought-ack must fire fast and
 * independently of the agent's full run.
 *
 * Activity content types (Linear): thought | response | error | elicitation
 * (all `{ type, body }`) and action (`{ type, action, parameter, result? }`).
 * See https://linear.app/developers/agent-interaction.
 */

import type { LinearAvaTokenManager } from "./ava-oauth-token-manager.ts";

const GRAPHQL_URL = "https://api.linear.app/graphql";

const MUTATION =
  "mutation AgentActivityCreate($input: AgentActivityCreateInput!) {" +
  " agentActivityCreate(input: $input) { success } }";

/** A Linear agent-activity content payload. */
export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

/** Build the agentActivityCreate variables — pure, exported for tests. */
export function buildActivityVariables(sessionId: string, content: AgentActivityContent) {
  return { input: { agentSessionId: sessionId, content } };
}

export class LinearAgentActivityClient {
  private readonly tokens: LinearAvaTokenManager;
  private readonly fetchImpl: typeof fetch;

  constructor(tokenManager: LinearAvaTokenManager, fetchImpl: typeof fetch = fetch) {
    this.tokens = tokenManager;
    this.fetchImpl = fetchImpl;
  }

  /** True when Ava's agent token is available (the dance has been completed). */
  isReady(): boolean {
    return this.tokens.isAuthorized();
  }

  /** POST a GraphQL op authenticated AS Ava (actor=app token). Throws loudly. */
  private async _gql(opName: string, query: string, variables: unknown): Promise<Record<string, unknown>> {
    const accessToken = await this.tokens.getAccessToken();
    const res = await this.fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`${opName} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: Record<string, unknown>; errors?: Array<{ message?: string }> };
    if (json.errors?.length) {
      throw new Error(`${opName} GraphQL error: ${json.errors.map(e => e.message).join("; ")}`);
    }
    return json.data ?? {};
  }

  /**
   * Post an activity into the session. Throws on auth/transport/GraphQL error so
   * callers surface it (fire-and-forget callers catch + log).
   */
  async createActivity(sessionId: string, content: AgentActivityContent): Promise<void> {
    const data = await this._gql("agentActivityCreate", MUTATION, buildActivityVariables(sessionId, content));
    const ok = (data.agentActivityCreate as { success?: boolean } | undefined)?.success;
    if (!ok) throw new Error("agentActivityCreate returned success=false");
  }

  /**
   * Post a normal issue comment AS Ava (actor=app), independent of any agent
   * session. This is what makes Ava's Linear replies show up authored by her
   * instead of by the operator's personal LINEAR_API_KEY — on the reliable
   * issue/comment path, not the flaky agent-session path.
   */
  async createComment(issueId: string, body: string): Promise<void> {
    const data = await this._gql(
      "commentCreate",
      "mutation($input: CommentCreateInput!){ commentCreate(input: $input){ success } }",
      { input: { issueId, body } },
    );
    const ok = (data.commentCreate as { success?: boolean } | undefined)?.success;
    if (!ok) throw new Error("commentCreate returned success=false");
  }

  /** Ava's own Linear user id (the actor=app identity), cached. */
  private _viewerId?: string;
  async getViewerId(): Promise<string> {
    if (this._viewerId) return this._viewerId;
    const data = await this._gql("viewer", "{ viewer { id } }", {});
    const id = (data.viewer as { id?: string } | undefined)?.id;
    if (!id) throw new Error("viewer query returned no id");
    this._viewerId = id;
    return id;
  }

  /**
   * True iff the issue is currently assigned to Ava (this app's actor). Used to
   * gate linear_agent_respond so Ava only acts on Linear issues that are hers —
   * not ambient activity or stale sessions on issues she was never assigned.
   */
  async isAssignedToAva(issueId: string): Promise<boolean> {
    const [viewerId, data] = await Promise.all([
      this.getViewerId(),
      this._gql("issueAssignee", "query($id:String!){ issue(id:$id){ assignee{ id } } }", { id: issueId }),
    ]);
    const assigneeId = ((data.issue as { assignee?: { id?: string } } | undefined)?.assignee)?.id;
    return !!assigneeId && assigneeId === viewerId;
  }

  thought(sessionId: string, body: string): Promise<void> {
    return this.createActivity(sessionId, { type: "thought", body });
  }
  response(sessionId: string, body: string): Promise<void> {
    return this.createActivity(sessionId, { type: "response", body });
  }
  error(sessionId: string, body: string): Promise<void> {
    return this.createActivity(sessionId, { type: "error", body });
  }
}

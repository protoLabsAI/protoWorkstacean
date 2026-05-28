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

  /**
   * Post an activity into the session. Throws on auth/transport/GraphQL error so
   * callers surface it (fire-and-forget callers catch + log).
   */
  async createActivity(sessionId: string, content: AgentActivityContent): Promise<void> {
    const accessToken = await this.tokens.getAccessToken();
    const res = await this.fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query: MUTATION, variables: buildActivityVariables(sessionId, content) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`agentActivityCreate HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      data?: { agentActivityCreate?: { success?: boolean } };
      errors?: Array<{ message?: string }>;
    };
    if (json.errors?.length) {
      throw new Error(`agentActivityCreate GraphQL error: ${json.errors.map(e => e.message).join("; ")}`);
    }
    if (!json.data?.agentActivityCreate?.success) {
      throw new Error("agentActivityCreate returned success=false");
    }
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

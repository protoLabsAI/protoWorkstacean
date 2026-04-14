/**
 * SessionContext — tracks SDK session IDs for conversation continuity.
 *
 * The SDK supports resuming a previous session via the `resume` option on query().
 * SessionStore holds in-memory session IDs keyed by `${correlationId}:${agentName}`,
 * enabling SkillDispatcherPlugin to resume the right session when the same user
 * sends a follow-up message to the same agent within the same conversation flow.
 *
 * Lifecycle:
 *   1. First invocation: no session → query() creates a new session.
 *   2. AgentExecutor.run() returns the session ID from session.getSessionId().
 *   3. SkillDispatcherPlugin stores it in SessionStore.
 *   4. Next invocation with the same correlationId+agentName: session ID is
 *      retrieved and passed as `resume` to query(), resuming conversation context.
 */

export interface SessionContext {
  /** SDK session ID to resume via query() options.resume */
  sessionId: string;
}

/**
 * In-memory store for SDK session IDs.
 * Keyed by `${correlationId}:${agentName}`.
 */
export class SessionStore {
  private readonly store = new Map<string, string>();

  private key(correlationId: string, agentName: string): string {
    return `${correlationId}:${agentName}`;
  }

  /** Return the stored session context, or undefined if none exists. */
  get(correlationId: string, agentName: string): SessionContext | undefined {
    const sessionId = this.store.get(this.key(correlationId, agentName));
    return sessionId !== undefined ? { sessionId } : undefined;
  }

  /** Persist a session ID for future resumption. */
  set(correlationId: string, agentName: string, sessionId: string): void {
    this.store.set(this.key(correlationId, agentName), sessionId);
  }

  /** Remove a stored session (e.g. after a terminal error). */
  delete(correlationId: string, agentName: string): void {
    this.store.delete(this.key(correlationId, agentName));
  }

  /** Number of active sessions in the store. */
  get size(): number {
    return this.store.size;
  }
}

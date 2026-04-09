/**
 * ConversationManager — tracks active multi-turn conversations by channel+user.
 *
 * When conversation is enabled for a Discord channel, each user gets a stable
 * conversationId that persists across turns until the session times out.
 * That conversationId becomes the bus correlationId, which the A2A layer
 * uses as the contextId — giving agents full conversation memory.
 *
 * Usage:
 *   const { conversationId, isNew, turnNumber } = manager.getOrCreate(channelId, userId)
 *   manager.has(channelId, userId)  // true if an active (non-expired) session exists
 *   manager.end(channelId, userId)  // terminate explicitly
 */

export interface ConversationEntry {
  conversationId: string;
  channelId: string;
  userId: string;
  agentName?: string;
  startedAt: number;
  lastActivity: number;
  timeoutMs: number;
  turnNumber: number;
}

type TimeoutCallback = (entry: ConversationEntry) => void;

export class ConversationManager {
  private conversations = new Map<string, ConversationEntry>();
  private onTimeout?: TimeoutCallback;
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(sweepIntervalMs = 30_000) {
    this.sweepTimer = setInterval(() => this._sweep(), sweepIntervalMs);
  }

  private _key(channelId: string, userId: string): string {
    return `${channelId}:${userId}`;
  }

  /**
   * Register a callback that fires when a conversation times out.
   * Called with the final state of the entry (turnNumber = last completed turn).
   */
  setTimeoutCallback(cb: TimeoutCallback): void {
    this.onTimeout = cb;
  }

  /**
   * Get or create a conversation for the given channel+user.
   * If an active conversation exists, increments its turnNumber and returns it.
   * If no active conversation exists (or it timed out), starts a new one.
   *
   * @returns { conversationId, isNew, turnNumber }
   */
  getOrCreate(
    channelId: string,
    userId: string,
    timeoutMs = 5 * 60_000,
    agentName?: string,
  ): { conversationId: string; isNew: boolean; turnNumber: number } {
    const key = this._key(channelId, userId);
    const now = Date.now();

    const existing = this.conversations.get(key);
    if (existing && now - existing.lastActivity < existing.timeoutMs) {
      existing.lastActivity = now;
      existing.turnNumber++;
      return { conversationId: existing.conversationId, isNew: false, turnNumber: existing.turnNumber };
    }

    const conversationId = crypto.randomUUID();
    const entry: ConversationEntry = {
      conversationId,
      channelId,
      userId,
      agentName,
      startedAt: now,
      lastActivity: now,
      timeoutMs,
      turnNumber: 1,
    };
    this.conversations.set(key, entry);
    return { conversationId, isNew: true, turnNumber: 1 };
  }

  /** Returns true if an active (non-expired) conversation exists for this channel+user. */
  has(channelId: string, userId: string): boolean {
    const key = this._key(channelId, userId);
    const entry = this.conversations.get(key);
    if (!entry) return false;
    return Date.now() - entry.lastActivity < entry.timeoutMs;
  }

  /** Terminate a conversation early (e.g. user types "goodbye"). */
  end(channelId: string, userId: string): boolean {
    return this.conversations.delete(this._key(channelId, userId));
  }

  /** All active (may include recently-expired, cleaned on next sweep) entries. */
  getActive(): ConversationEntry[] {
    return Array.from(this.conversations.values());
  }

  destroy(): void {
    clearInterval(this.sweepTimer);
    this.conversations.clear();
  }

  private _sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.conversations) {
      if (now - entry.lastActivity >= entry.timeoutMs) {
        this.conversations.delete(key);
        console.log(
          `[conversation] Conversation ${entry.conversationId} timed out ` +
          `(${entry.turnNumber} turn(s), user ${entry.userId} in channel ${entry.channelId})`,
        );
        this.onTimeout?.(entry);
      }
    }
  }
}

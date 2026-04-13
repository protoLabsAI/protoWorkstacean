/**
 * ContextMailbox — in-memory message store for mid-execution context injection.
 *
 * When a user sends additional Discord DMs while an agent is already processing
 * a prior request, those messages land here. Two drain paths exist:
 *
 *   1. Remote agent polls GET /api/mailbox/:contextId between tool calls
 *   2. SkillDispatcherPlugin auto-drains on execution completion
 *
 * Keyed by contextId (= correlationId = conversationId in the DM flow).
 * Single-threaded JS guarantees atomic drain — no messages lost between
 * check and delete.
 */

export interface MailboxMessage {
  content: string;
  receivedAt: number;
  sender?: string;
}

export class ContextMailbox {
  private readonly store = new Map<string, MailboxMessage[]>();
  private readonly ttlMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(opts?: { ttlMs?: number; sweepIntervalMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? Number(process.env.MAILBOX_TTL_MS ?? 10 * 60_000);
    this.sweepTimer = setInterval(
      () => this._sweep(),
      opts?.sweepIntervalMs ?? 60_000,
    );
  }

  /** Push a message into the mailbox for a given contextId. */
  push(contextId: string, msg: MailboxMessage): void {
    const existing = this.store.get(contextId);
    if (existing) {
      existing.push(msg);
    } else {
      this.store.set(contextId, [msg]);
    }
  }

  /** Atomically drain all pending messages for a contextId. Returns [] if empty. */
  drain(contextId: string): MailboxMessage[] {
    const messages = this.store.get(contextId);
    if (!messages) return [];
    this.store.delete(contextId);
    return messages;
  }

  /** Peek without draining. */
  peek(contextId: string): MailboxMessage[] {
    return this.store.get(contextId) ?? [];
  }

  /** Check if any messages are pending. */
  has(contextId: string): boolean {
    const msgs = this.store.get(contextId);
    return !!msgs && msgs.length > 0;
  }

  /** Number of contextIds with pending messages. */
  get size(): number {
    return this.store.size;
  }

  /**
   * Format drained messages for agent consumption.
   *
   * Single message: raw content, no wrapping.
   * Multiple messages: numbered `[1/N]` delimiters so the agent can distinguish
   * individual messages even when they contain blank lines.
   */
  static format(messages: MailboxMessage[]): string {
    if (messages.length === 0) return "";
    if (messages.length === 1) return messages[0].content;

    const header = "[User sent additional messages while you were working]\n";
    const body = messages
      .map((m, i) => `[${i + 1}/${messages.length}] ${m.content}`)
      .join("\n\n");
    return header + "\n" + body;
  }

  /** Stop the TTL sweep timer. */
  destroy(): void {
    clearInterval(this.sweepTimer);
  }

  /** Remove messages older than ttlMs. Drop empty slots. */
  private _sweep(): void {
    const now = Date.now();
    for (const [contextId, messages] of this.store) {
      const live = messages.filter(m => now - m.receivedAt < this.ttlMs);
      if (live.length === 0) {
        this.store.delete(contextId);
      } else if (live.length < messages.length) {
        this.store.set(contextId, live);
      }
    }
  }
}

/**
 * DmAccumulator — sliding-window debounce for Discord DMs.
 *
 * When a user sends rapid-fire DMs, each message resets a timer. Once the
 * timer fires (default 3 s of silence), the accumulated batch is flushed
 * via the onFlush callback.
 *
 * Key behaviour:
 *   - First message in a batch: caller gets `true` from push() → react with 👀
 *   - Subsequent messages: update lastMessage, append content, reset timer
 *   - Timer fires: delete entry first, then call onFlush inside try/catch
 *   - If onFlush throws: log + push to fallback mailbox so messages are never lost
 */

import type { ContextMailbox } from "./context-mailbox.ts";

/**
 * Minimal subset of Discord.js Message used by the accumulator.
 * Keeps the module testable without pulling in discord.js.
 */
export interface AccumulatorMessage {
  id: string;
  channelId: string;
}

export interface AccumulatorEntry {
  conversationId: string;
  userId: string;
  channelId: string;
  agentName: string | undefined;
  lastMessage: AccumulatorMessage;
  contents: string[];
  timer: ReturnType<typeof setTimeout>;
  turnNumber: number;
  isNew: boolean;
}

export type FlushCallback = (entry: Omit<AccumulatorEntry, "timer">) => void | Promise<void>;

export interface DmAccumulatorOptions {
  debounceMs?: number;
  onFlush: FlushCallback;
  /** Fallback mailbox — if onFlush throws, content is pushed here so messages aren't lost. */
  fallbackMailbox?: ContextMailbox;
}

export class DmAccumulator {
  private readonly entries = new Map<string, AccumulatorEntry>();
  private readonly debounceMs: number;
  private readonly onFlush: FlushCallback;
  private readonly fallbackMailbox?: ContextMailbox;

  constructor(opts: DmAccumulatorOptions) {
    this.debounceMs = opts.debounceMs ?? Number(process.env.DM_DEBOUNCE_MS ?? 3000);
    this.onFlush = opts.onFlush;
    this.fallbackMailbox = opts.fallbackMailbox;
  }

  /**
   * Push a DM message into the accumulator.
   *
   * @returns true if this was the first message in the batch (caller should react with 👀)
   */
  push(params: {
    conversationId: string;
    userId: string;
    channelId: string;
    agentName: string | undefined;
    message: AccumulatorMessage;
    content: string;
    turnNumber: number;
    isNew: boolean;
  }): boolean {
    const existing = this.entries.get(params.conversationId);

    if (existing) {
      // Append content, update lastMessage, reset timer
      existing.contents.push(params.content);
      existing.lastMessage = params.message;
      clearTimeout(existing.timer);
      existing.timer = this._startTimer(params.conversationId);
      return false;
    }

    // First message — create entry
    const entry: AccumulatorEntry = {
      conversationId: params.conversationId,
      userId: params.userId,
      channelId: params.channelId,
      agentName: params.agentName,
      lastMessage: params.message,
      contents: [params.content],
      timer: this._startTimer(params.conversationId),
      turnNumber: params.turnNumber,
      isNew: params.isNew,
    };
    this.entries.set(params.conversationId, entry);
    return true;
  }

  /** Cancel a pending accumulator entry without flushing. */
  cancel(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (entry) {
      clearTimeout(entry.timer);
      this.entries.delete(conversationId);
    }
  }

  /** Number of pending (not yet flushed) entries. */
  get pending(): number {
    return this.entries.size;
  }

  /** Cancel all timers and clear state. */
  destroy(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
    }
    this.entries.clear();
  }

  private _startTimer(conversationId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => this._flush(conversationId), this.debounceMs);
  }

  private _flush(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (!entry) return;

    // Delete BEFORE calling onFlush — entry is consumed regardless of outcome
    this.entries.delete(conversationId);

    const { timer: _timer, ...rest } = entry;

    try {
      const result = this.onFlush(rest);
      // Handle async flush errors
      if (result && typeof result.then === "function") {
        result.then(undefined, (err: unknown) => this._handleFlushError(conversationId, rest, err));
      }
    } catch (err) {
      this._handleFlushError(conversationId, rest, err);
    }
  }

  private _handleFlushError(
    conversationId: string,
    entry: Omit<AccumulatorEntry, "timer">,
    err: unknown,
  ): void {
    console.error(
      `[dm-accumulator] Flush error for ${conversationId}:`,
      err instanceof Error ? err.message : err,
    );

    // Fallback: push to mailbox so messages aren't lost
    if (this.fallbackMailbox) {
      const batchedContent = entry.contents.length === 1
        ? entry.contents[0]
        : entry.contents.map((c, i) => `[${i + 1}/${entry.contents.length}] ${c}`).join("\n\n");

      this.fallbackMailbox.push(conversationId, {
        content: batchedContent,
        sender: entry.userId,
        receivedAt: Date.now(),
      });
      console.log(
        `[dm-accumulator] Pushed ${entry.contents.length} message(s) to mailbox fallback for ${conversationId}`,
      );
    }
  }
}

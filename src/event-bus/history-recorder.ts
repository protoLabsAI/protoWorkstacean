/**
 * BusHistoryRecorder — in-memory ring buffer that captures every bus message
 * for later replay/inspection. Backs the dashboard's /system/trace/:correlationId
 * waterfall (D1) so an operator can step through a skill's full causal chain
 * without leaving the UI for Langfuse.
 *
 * Design:
 *   - Subscribe to "#" once via the recorder plugin → every published message
 *     lands in the buffer in publish order.
 *   - Ring buffer capped at MAX_EVENTS (10k by default) — overwrites oldest
 *     on the (MAX_EVENTS + 1)th event. Memory ceiling is ~10k * (small BusMessage)
 *     = single-digit MBs; bounded by message-payload size, not entry count.
 *   - 30-min TTL: entries older than this are skipped on read AND swept by a
 *     periodic pruner so old payloads can be GC'd between bursts.
 *
 * Read API:
 *   - byCorrelationId(id) — every message whose `correlationId === id`,
 *     oldest first. Used by /api/bus/history?correlationId=...
 *   - recent(limit) — most recent N messages across all correlations, used
 *     by /api/bus/history (no filter) for debug dumps.
 *
 * Not durable. Process restart wipes history. That's fine for the live-debug
 * use case — anyone wanting persistent traces uses Langfuse.
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import { logger } from "../../lib/log.ts";

const log = logger("bus-history-recorder");

const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60_000;

export interface HistoryRecorderConfig {
  maxEvents?: number;
  ttlMs?: number;
}

export class BusHistoryRecorder {
  private readonly ring: BusMessage[];
  private readonly maxEvents: number;
  private readonly ttlMs: number;
  private head = 0;
  private size = 0;

  constructor(config: HistoryRecorderConfig = {}) {
    this.maxEvents = config.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.ring = new Array(this.maxEvents);
  }

  record(msg: BusMessage): void {
    this.ring[this.head] = msg;
    this.head = (this.head + 1) % this.maxEvents;
    if (this.size < this.maxEvents) this.size++;
  }

  /**
   * Every message whose correlationId matches, oldest first. Honours TTL —
   * older entries are skipped even if still in the ring.
   */
  byCorrelationId(correlationId: string): BusMessage[] {
    const cutoff = Date.now() - this.ttlMs;
    const out: BusMessage[] = [];
    for (const msg of this._iterOldestFirst()) {
      if (!msg) continue;
      if (msg.timestamp < cutoff) continue;
      if (msg.correlationId === correlationId) out.push(msg);
    }
    return out;
  }

  /**
   * The N most-recent messages across all correlations, freshest last (i.e.
   * the same order as they were published). Honours TTL.
   */
  recent(limit: number): BusMessage[] {
    const cutoff = Date.now() - this.ttlMs;
    const all: BusMessage[] = [];
    for (const msg of this._iterOldestFirst()) {
      if (!msg) continue;
      if (msg.timestamp < cutoff) continue;
      all.push(msg);
    }
    return all.slice(-limit);
  }

  stats(): { size: number; capacity: number; ttlMs: number } {
    return { size: this.size, capacity: this.maxEvents, ttlMs: this.ttlMs };
  }

  /**
   * Drop entries past the TTL by overwriting with `undefined`. Called from
   * a 1-min timer so old payloads become GC-eligible without waiting for
   * the ring to overwrite them.
   */
  prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    let purged = 0;
    for (let i = 0; i < this.maxEvents; i++) {
      const msg = this.ring[i];
      if (msg && msg.timestamp < cutoff) {
        this.ring[i] = undefined as unknown as BusMessage;
        purged++;
      }
    }
    if (purged > 0 && this.size > 0) {
      // size tracks high-water; we don't decrement on prune so future
      // record() calls keep using ring slots in order. byCorrelationId /
      // recent already skip undefined entries.
    }
  }

  private *_iterOldestFirst(): IterableIterator<BusMessage | undefined> {
    if (this.size < this.maxEvents) {
      // Ring hasn't wrapped yet — entries 0..size-1 are in order.
      for (let i = 0; i < this.size; i++) yield this.ring[i];
      return;
    }
    // Wrapped — head points at the oldest slot.
    for (let i = 0; i < this.maxEvents; i++) {
      yield this.ring[(this.head + i) % this.maxEvents];
    }
  }
}

/**
 * Plugin that subscribes to `#` and writes every message to a shared
 * BusHistoryRecorder. The recorder is the contract surface — the plugin is
 * just the wiring.
 */
export class BusHistoryRecorderPlugin implements Plugin {
  readonly name = "bus-history-recorder";
  readonly description =
    "Records every bus message into an in-memory ring buffer for /api/bus/history";
  readonly capabilities = ["bus-history"];

  private subscriptionId: string | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(public readonly recorder: BusHistoryRecorder) {}

  install(bus: EventBus): void {
    this.subscriptionId = bus.subscribe("#", this.name, msg => this.recorder.record(msg));
    this.pruneTimer = setInterval(() => this.recorder.prune(), PRUNE_INTERVAL_MS);
    if (typeof this.pruneTimer.unref === "function") this.pruneTimer.unref();
    log.info(
      `installed (cap=${this.recorder.stats().capacity}, ttlMs=${this.recorder.stats().ttlMs})`,
    );
  }

  uninstall(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.subscriptionId = null;
  }
}

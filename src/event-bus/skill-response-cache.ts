/**
 * SkillResponseCache — in-memory, correlationId-keyed cache of terminal skill
 * responses. Backs GET /api/a2a/task/:correlationId so a caller that stopped
 * awaiting a dispatch (e.g. a chat request that hit its reply timeout, or a
 * fire-and-forget delegate) can still fetch the final outcome.
 *
 * Why a bus subscriber: every terminal response — whether from the dispatcher's
 * inline-complete path (in-process DeepAgents) or TaskTracker's terminal path
 * (long-running A2A tasks) — is published to `agent.skill.response.{correlationId}`.
 * Subscribing to that one topic captures BOTH uniformly with zero producer
 * changes, instead of bolting a cache onto each producer. This is the single
 * code path the prior per-component cache (TaskTracker.recentResults) couldn't
 * provide: in-process executors never reach TaskTracker, so their results were
 * never cacheable.
 *
 * Bounded by TTL + a hard entry cap. Not durable — process restart wipes it,
 * which is fine: the cache only needs to survive the minutes between a dispatch
 * timing out and the caller polling.
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { AgentSkillResponsePayload } from "./payloads.ts";
import { logger } from "../../lib/log.ts";

const log = logger("skill-response-cache");

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5_000;
const PRUNE_INTERVAL_MS = 60_000;
const RESPONSE_TOPIC_WILDCARD = "agent.skill.response.#";

export interface SkillResponseCacheConfig {
  ttlMs?: number;
  maxEntries?: number;
}

export class SkillResponseCache {
  /** Insertion-ordered (Map preserves it) so the oldest entry is evictable. */
  private readonly store = new Map<string, { payload: AgentSkillResponsePayload; at: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(config: SkillResponseCacheConfig = {}) {
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Cache a terminal skill response. Keyed on the message's correlationId
   * (always set on a BusMessage), falling back to the payload's. Skips entries
   * with no resolvable correlationId.
   */
  record(msg: BusMessage): void {
    const payload = (msg.payload ?? {}) as AgentSkillResponsePayload;
    const correlationId = msg.correlationId ?? payload.correlationId;
    if (!correlationId) return;

    this.store.set(correlationId, { payload, at: Date.now() });

    // Hard cap backstop against a burst between prune cycles — evict oldest.
    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  /**
   * The cached response for a correlationId, or undefined if never seen or aged
   * past the TTL (expired entries are dropped on read).
   */
  get(correlationId: string): AgentSkillResponsePayload | undefined {
    const entry = this.store.get(correlationId);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.store.delete(correlationId);
      return undefined;
    }
    return entry.payload;
  }

  stats(): { size: number; maxEntries: number; ttlMs: number } {
    return { size: this.store.size, maxEntries: this.maxEntries, ttlMs: this.ttlMs };
  }

  /** Drop entries past the TTL so payloads become GC-eligible between reads. */
  prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [correlationId, entry] of this.store) {
      if (entry.at < cutoff) this.store.delete(correlationId);
    }
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Plugin that subscribes to `agent.skill.response.#` and writes every terminal
 * response into a shared SkillResponseCache. The cache is the contract surface
 * (injected into ApiContext); the plugin is just the wiring.
 */
export class SkillResponseCachePlugin implements Plugin {
  readonly name = "skill-response-cache";
  readonly description =
    "Caches terminal skill responses by correlationId for GET /api/a2a/task/:correlationId";
  readonly capabilities = ["skill-response-cache"];

  private bus: EventBus | null = null;
  private subscriptionId: string | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(public readonly cache: SkillResponseCache) {}

  install(bus: EventBus): void {
    this.bus = bus;
    this.subscriptionId = bus.subscribe(RESPONSE_TOPIC_WILDCARD, this.name, (msg) => this.cache.record(msg));
    this.pruneTimer = setInterval(() => this.cache.prune(), PRUNE_INTERVAL_MS);
    if (typeof this.pruneTimer.unref === "function") this.pruneTimer.unref();
    log.info(
      `installed (maxEntries=${this.cache.stats().maxEntries}, ttlMs=${this.cache.stats().ttlMs})`,
    );
  }

  uninstall(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.bus && this.subscriptionId) this.bus.unsubscribe(this.subscriptionId);
    this.subscriptionId = null;
    this.bus = null;
  }
}

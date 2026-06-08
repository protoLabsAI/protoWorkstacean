/**
 * FlowStorePlugin — persists `flow.item.*` dispatch events into the durable
 * FlowStore so the orchestration canvas (ADR-0008 P1) can browse + replay
 * execution history across restarts.
 *
 * Pure bus consumer: subscribes to the three flow-item topics and upserts each
 * payload. A periodic sweep enforces retention so the log stays bounded (the
 * events.db lesson). Never throws into the bus — persistence must not break a
 * dispatch.
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { FlowStore } from "../knowledge/flow-store.ts";
import type { FlowItemPayload } from "../event-bus/payloads.ts";
import { logger } from "../../lib/log.ts";

const log = logger("flow-store-plugin");

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

export class FlowStorePlugin implements Plugin {
  readonly name = "flow-store";
  readonly description = "Persists flow.item.* dispatch events into the durable FlowStore (backs the orchestration canvas)";
  readonly capabilities = ["flow-persistence"];
  readonly subscribes = ["flow.item.created", "flow.item.updated", "flow.item.completed"];

  private subscriptionIds: string[] = [];
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: FlowStore,
    opts: { retentionMs?: number; now?: () => number } = {},
  ) {
    this.retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    this.now = opts.now ?? Date.now;
  }

  install(bus: EventBus): void {
    const persist = (msg: BusMessage) => {
      const payload = msg.payload as FlowItemPayload | undefined;
      if (payload?.id) this.store.upsert(payload);
    };
    for (const topic of this.subscribes) {
      this.subscriptionIds.push(bus.subscribe(topic, this.name, persist));
    }
    // Cold-start prune + hourly sweep so the log stays bounded.
    this.store.prune(this.now() - this.retentionMs);
    this.sweepTimer = setInterval(() => {
      this.store.prune(this.now() - this.retentionMs);
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
    log.info(`installed — persisting flow.item.* (retention ${Math.round(this.retentionMs / 86_400_000)}d)`);
  }

  uninstall(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.subscriptionIds = [];
  }
}

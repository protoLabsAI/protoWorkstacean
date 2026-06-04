/**
 * AppAlertPlugin — surfaces app-SELF failures to the ops Discord webhook.
 *
 * The fleet-alerts evaluator alerts on fleet *agents*; nothing alerted on the
 * switchboard itself. This subscribes to `system.error` (emitted by the bus when
 * a subscriber handler throws — #800) and posts a throttled message to
 * `DISCORD_OPS_WEBHOOK_URL`, so a handler erroring on every message (or another
 * app-level fault) becomes visible instead of a silent console.error.
 *
 * Throttled per error-key to avoid a storm, and it NEVER throws back into the
 * bus (that would re-emit `system.error` → loop).
 */

import type { Plugin, EventBus, BusMessage } from "../types.ts";
import { logger } from "../log.ts";

const log = logger("app-alert");

interface SystemErrorPayload {
  source?: string;
  plugin?: string;
  pattern?: string;
  error?: string;
}

export class AppAlertPlugin implements Plugin {
  readonly name = "app-alert";
  readonly description = "Posts app-self errors (system.error) to the ops Discord webhook, throttled";
  readonly capabilities = ["system.error", "ops-alert"];

  private bus?: EventBus;
  private subId?: string;
  private readonly webhookUrl?: string;
  private readonly throttleMs: number;
  private readonly lastSent = new Map<string, number>();
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { webhookUrl?: string; throttleMs?: number; now?: () => number; fetchImpl?: typeof fetch } = {}) {
    this.webhookUrl = opts.webhookUrl ?? process.env.DISCORD_OPS_WEBHOOK_URL;
    this.throttleMs = opts.throttleMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  install(bus: EventBus): void {
    this.bus = bus;
    this.subId = bus.subscribe("system.error", this.name, (m) => { void this._onError(m); });
    log.info(`installed — system.error → ops webhook${this.webhookUrl ? "" : " (no DISCORD_OPS_WEBHOOK_URL; logging only)"}`);
  }

  uninstall(): void {
    if (this.subId) this.bus?.unsubscribe(this.subId);
    this.subId = undefined;
  }

  private async _onError(msg: BusMessage): Promise<void> {
    const p = (msg.payload ?? {}) as SystemErrorPayload;
    const key = `${p.source ?? "?"}:${p.plugin ?? p.pattern ?? "?"}`;
    const now = this.now();
    if (now - (this.lastSent.get(key) ?? Number.NEGATIVE_INFINITY) < this.throttleMs) return; // per-key throttle
    this.lastSent.set(key, now);
    if (!this.webhookUrl) return;
    const content = `🚨 **workstacean app error** — ${p.source ?? "?"} (${p.plugin ?? p.pattern ?? "?"}): ${String(p.error ?? "").slice(0, 300)}`;
    try {
      await this.fetchImpl(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
    } catch (e) {
      // Must not throw back into the bus (would re-emit system.error → loop).
      log.warn("ops webhook post failed", { err: e });
    }
  }
}

/**
 * DispatchDropEscalatorPlugin — escalates dispatch-drop storms to the operator.
 *
 * A single dispatch drop is rarely interesting — cooldowns are by design,
 * target-unresolved on first attempt may just be a startup race, and
 * no-skill is usually a misconfigured caller. But the SAME drop key firing
 * 10+ times in 10min is a stuck loop signal: webhooks keep hammering the
 * dispatcher, and either the rate-limit is too aggressive for legitimate
 * traffic OR the caller is in a tight retry loop that won't drain on its
 * own.
 *
 * Per the bottlenecks-are-growth principle, that escalates: drop-storms
 * surface as `operator.message.request` via the existing OperatorRoutingPlugin
 * pipe (same as feature-remediation stuck-feature escalations). The operator
 * decides whether to bump the cooldown, fix the caller, or stop the loop.
 *
 * Subscribes to: dispatch.dropped.# (from SkillDispatcherPlugin, #620)
 * Publishes to:  operator.message.request (consumed by OperatorRoutingPlugin)
 *
 * Per-key cooldown prevents a sustained storm from filling the operator's
 * DM. One escalation per (key, cooldown window) regardless of subsequent
 * drops in the same window.
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { DispatchDroppedPayload } from "../event-bus/payloads.ts";
import { logger } from "../../lib/log.ts";

const log = logger("dispatch-drop-escalator");

/** Drops in this rolling window count toward the storm threshold. */
const STORM_WINDOW_MS_DEFAULT = 10 * 60_000;
/** Drop count within the window that trips an escalation. */
const STORM_THRESHOLD_DEFAULT = 10;
/** Minimum interval between escalations for the same drop key. */
const ESCALATION_COOLDOWN_MS_DEFAULT = 30 * 60_000;

interface DropRecord {
  timestamps: number[];
  /** Most recent drop payload for context in the escalation message. */
  lastPayload: DispatchDroppedPayload;
}

export class DispatchDropEscalatorPlugin implements Plugin {
  readonly name = "dispatch-drop-escalator";
  readonly description =
    "Escalates dispatch-drop storms (N drops on same key in M min) to the operator via operator.message.request";
  readonly capabilities = ["dispatch-drop-escalator"];

  private bus?: EventBus;
  private subscriptionId?: string;
  private readonly drops = new Map<string, DropRecord>();
  private readonly lastEscalatedAt = new Map<string, number>();

  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly escalationCooldownMs: number;

  constructor() {
    this.windowMs =
      Number(process.env["WORKSTACEAN_DISPATCH_DROP_WINDOW_MS"]) || STORM_WINDOW_MS_DEFAULT;
    this.threshold =
      Number(process.env["WORKSTACEAN_DISPATCH_DROP_THRESHOLD"]) || STORM_THRESHOLD_DEFAULT;
    this.escalationCooldownMs =
      Number(process.env["WORKSTACEAN_DISPATCH_DROP_ESCALATION_COOLDOWN_MS"]) ||
      ESCALATION_COOLDOWN_MS_DEFAULT;
  }

  install(bus: EventBus): void {
    this.bus = bus;
    this.subscriptionId = bus.subscribe("dispatch.dropped.#", this.name, (msg: BusMessage) => {
      this._onDrop(msg);
    });
    log.info(
      `Installed — threshold=${this.threshold} drops / ` +
        `${Math.round(this.windowMs / 60_000)}min, escalationCooldown=${Math.round(this.escalationCooldownMs / 60_000)}min`,
    );
  }

  uninstall(): void {
    if (this.bus && this.subscriptionId !== undefined) {
      this.bus.unsubscribe(this.subscriptionId);
    }
    this.bus = undefined;
    this.subscriptionId = undefined;
    this.drops.clear();
    this.lastEscalatedAt.clear();
  }

  private _onDrop(msg: BusMessage): void {
    const payload = msg.payload as DispatchDroppedPayload | undefined;
    if (!payload || !payload.reason) return;

    const key = this._dropKey(payload);
    const now = Date.now();

    const record = this.drops.get(key) ?? { timestamps: [], lastPayload: payload };
    record.lastPayload = payload;
    // Prune outside the rolling window. Bounded — never more than threshold+a-few entries.
    record.timestamps = record.timestamps.filter(t => now - t < this.windowMs);

    // Delete the key if no timestamps remain — prevents unbounded growth
    // for drop keys that fire once and never recur.
    if (record.timestamps.length === 0) {
      this.drops.delete(key);
      return;
    }

    record.timestamps.push(now);
    this.drops.set(key, record);

    if (record.timestamps.length < this.threshold) return;

    const lastEscalation = this.lastEscalatedAt.get(key);
    if (lastEscalation !== undefined && now - lastEscalation < this.escalationCooldownMs) return;

    this.lastEscalatedAt.set(key, now);

    // Lazy-evict expired escalation cooldown keys.
    this._sweepLastEscalatedAt(now);

    this._escalate(key, record);
  }

  /**
   * Build the de-dup key. (reason, skill, target_or_bucket) — drops sharing
   * all three count toward the same storm. Cooldown-key is preferred when
   * available (it already encodes skill+repo for cooldown reason); falls back
   * to first target or "?" for no-skill drops.
   */
  private _dropKey(p: DispatchDroppedPayload): string {
    const skill = p.skill ?? "?";
    const target = p.cooldownKey ?? (p.targets && p.targets.length > 0 ? p.targets.join(",") : "?");
    return `${p.reason}:${skill}:${target}`;
  }

  private _escalate(key: string, record: DropRecord): void {
    if (!this.bus) return;

    const count = record.timestamps.length;
    const oldest = record.timestamps[0]!;
    const ageMin = Math.max(1, Math.round((Date.now() - oldest) / 60_000));
    const reasonHuman = this._reasonHuman(record.lastPayload.reason);

    const lines = [
      `Dispatch-drop storm: \`${key}\` triggered ${count} times in last ${ageMin}m.`,
      "",
      `**Reason:** ${reasonHuman}`,
      `**Sample message:** ${record.lastPayload.message}`,
    ];
    if (record.lastPayload.reason === "cooldown" && record.lastPayload.cooldownWindowMs) {
      lines.push(
        `**Cooldown window:** ${record.lastPayload.cooldownWindowMs}ms — if this is legitimate traffic, ` +
          `consider raising via WORKSTACEAN_COOLDOWN_MS_<SKILL>.`,
      );
    }

    const correlationId = `dispatch-drop-${key}-${Date.now()}`;
    this.bus.publish("operator.message.request", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "operator.message.request",
      timestamp: Date.now(),
      payload: {
        type: "operator_message_request",
        correlationId,
        message: lines.join("\n"),
        urgency: record.lastPayload.reason === "cooldown" ? "normal" : "high",
        topic: `dispatch-drop-storm/${record.lastPayload.reason}`,
        from: "dispatch-drop-escalator",
      },
    });

    log.warn(
      `STORM → escalating: ${key} (${count} drops in ${ageMin}min)`,
    );
  }

  private _reasonHuman(reason: string): string {
    switch (reason) {
      case "cooldown":
        return "Cooldown trips — same skill+repo dispatched faster than its cooldown window allows.";
      case "target_unresolved":
        return "Target executor not in ExecutorRegistry — config error, undeployed agent, or stale target name.";
      case "no_skill":
        return "Caller published agent.skill.request with no skill field — bug in the caller.";
      default:
        return `Unknown reason: ${reason}`;
    }
  }

  /** Purge escalation-cooldown keys whose window has elapsed. */
  private _sweepLastEscalatedAt(now: number): void {
    for (const [key, ts] of this.lastEscalatedAt) {
      if (now - ts >= this.escalationCooldownMs) {
        this.lastEscalatedAt.delete(key);
      }
    }
  }
}

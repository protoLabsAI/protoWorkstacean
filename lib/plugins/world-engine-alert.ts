/**
 * WorldEngineAlertPlugin — routes world engine goal-violation alerts to Discord.
 *
 * Subscribes to: message.outbound.discord.alert
 *
 * When ActionDispatcher fires an action with meta.topic = "message.outbound.discord.alert",
 * this plugin receives the event and POSTs an embed to the configured alerts webhook.
 *
 * Config (env vars):
 *   DISCORD_WEBHOOK_ALERTS  — fleet-wide alerts channel webhook URL
 */

import type { Plugin, EventBus, BusMessage } from "../types.ts";
import { CONFIG } from "../../src/config/env.ts";

const SEVERITY_COLORS: Record<string, number> = {
  high: 0xED4245,    // Red
  medium: 0xFF6B00,  // Orange
  low: 0xFEE75C,     // Yellow
};

export class WorldEngineAlertPlugin implements Plugin {
  readonly name = "world-engine-alert";
  readonly description = "Routes world engine goal violations to the Discord alerts webhook";
  readonly capabilities = ["discord-alerts"];

  private bus?: EventBus;
  private readonly subscriptionIds: string[] = [];

  install(bus: EventBus): void {
    this.bus = bus;

    const subId = bus.subscribe("message.outbound.discord.alert", this.name, (msg: BusMessage) => {
      void this._handleAlert(msg);
    });
    this.subscriptionIds.push(subId);

    const webhookConfigured = !!CONFIG.DISCORD_WEBHOOK_ALERTS;
    console.log(
      `[world-engine-alert] Plugin installed — alerts webhook ${webhookConfigured ? "configured" : "NOT configured (set DISCORD_WEBHOOK_ALERTS)"}`,
    );
  }

  uninstall(): void {
    if (this.bus) {
      for (const id of this.subscriptionIds) {
        this.bus.unsubscribe(id);
      }
    }
    this.subscriptionIds.length = 0;
    this.bus = undefined;
  }

  private async _handleAlert(msg: BusMessage): Promise<void> {
    const webhookUrl = CONFIG.DISCORD_WEBHOOK_ALERTS;
    if (!webhookUrl) {
      console.warn("[world-engine-alert] DISCORD_WEBHOOK_ALERTS not set — alert dropped");
      return;
    }

    const payload = msg.payload as {
      actionId?: string;
      goalId?: string;
      meta?: { agentId?: string; severity?: string };
    };

    const severity = payload.meta?.severity ?? "medium";
    const color = SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.medium;

    const embed = {
      title: "World Engine Alert",
      description: `Goal \`${payload.goalId ?? "unknown"}\` violated — automated action dispatched`,
      color,
      fields: [
        { name: "Action", value: payload.actionId ?? "unknown", inline: true },
        { name: "Severity", value: severity, inline: true },
        { name: "Agent", value: payload.meta?.agentId ?? "system", inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: "protoWorkstacean World Engine" },
    };

    try {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
        signal: AbortSignal.timeout(5_000),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "(no body)");
        console.error(`[world-engine-alert] Webhook POST failed: HTTP ${resp.status} — ${text}`);
      } else {
        console.log(`[world-engine-alert] Alert sent: goal=${payload.goalId} action=${payload.actionId}`);
      }
    } catch (err) {
      console.error("[world-engine-alert] Failed to send alert:", err instanceof Error ? err.message : String(err));
    }
  }
}

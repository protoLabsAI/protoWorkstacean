/**
 * CeremonyNotifier — sends ceremony execution outcomes to Discord.
 *
 * Uses the DISCORD_CEREMONY_WEBHOOK_URL environment variable by default.
 * Per-ceremony notifyChannel overrides are resolved to webhook URLs via
 * DISCORD_WEBHOOK_{CHANNEL_SLUG_UPPERCASE} env vars, e.g.
 * DISCORD_WEBHOOK_GENERAL for notifyChannel: "general".
 *
 * Falls back to console logging on missing config or network error.
 * Discord notifications are always non-blocking.
 */

import type { CeremonyOutcome } from "../../plugins/CeremonyPlugin.types.ts";

const STATUS_COLORS: Record<string, number> = {
  success: 0x2ecc71,  // green
  failure: 0xe74c3c,  // red
  timeout: 0xf39c12,  // orange
};

export class CeremonyNotifier {
  private defaultWebhookUrl: string | null;

  constructor(webhookUrl?: string) {
    this.defaultWebhookUrl = webhookUrl ?? process.env.DISCORD_CEREMONY_WEBHOOK_URL ?? null;
    if (!this.defaultWebhookUrl) {
      console.info("[ceremony-notifier] DISCORD_CEREMONY_WEBHOOK_URL not set — using console fallback");
    }
  }

  /**
   * Send a ceremony outcome notification to Discord.
   * If notifyChannel is provided, attempts to resolve a channel-specific webhook.
   * Returns true on success, false on fallback.
   */
  async notify(outcome: CeremonyOutcome, ceremonyName: string, notifyChannel?: string): Promise<boolean> {
    const webhookUrl = this._resolveWebhook(notifyChannel);

    if (!webhookUrl) {
      this._logFallback(outcome, ceremonyName);
      return false;
    }

    const embed = this._buildEmbed(outcome, ceremonyName);

    try {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Discord webhook error ${resp.status}: ${body}`);
      }

      return true;
    } catch (err) {
      console.error("[ceremony-notifier] Discord integration error:", err);
      this._logFallback(outcome, ceremonyName);
      return false;
    }
  }

  private _resolveWebhook(channelSlug?: string): string | null {
    if (channelSlug) {
      // Try channel-specific webhook env var
      const envKey = `DISCORD_WEBHOOK_${channelSlug.toUpperCase().replace(/-/g, "_")}`;
      const channelUrl = process.env[envKey];
      if (channelUrl) return channelUrl;
    }
    return this.defaultWebhookUrl;
  }

  private _logFallback(outcome: CeremonyOutcome, ceremonyName: string): void {
    const durationSec = (outcome.duration / 1000).toFixed(1);
    console.log(
      `[ceremony-notifier:fallback] Ceremony "${ceremonyName}" (${outcome.ceremonyId}) ` +
      `${outcome.status.toUpperCase()} in ${durationSec}s — run ${outcome.runId}`,
    );
  }

  private _buildEmbed(outcome: CeremonyOutcome, ceremonyName: string): Record<string, unknown> {
    const color = STATUS_COLORS[outcome.status] ?? STATUS_COLORS.failure;
    const durationSec = (outcome.duration / 1000).toFixed(1);
    const ts = new Date(outcome.completedAt).toISOString();
    const statusEmoji = outcome.status === "success" ? "✅" : outcome.status === "timeout" ? "⏱️" : "❌";

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: "Ceremony", value: `\`${outcome.ceremonyId}\``, inline: true },
      { name: "Skill", value: `\`${outcome.skill}\``, inline: true },
      { name: "Duration", value: `${durationSec}s`, inline: true },
      { name: "Targets", value: outcome.targets.join(", ").slice(0, 200) || "none", inline: false },
    ];

    if (outcome.result) {
      fields.push({
        name: "Result",
        value: outcome.result.slice(0, 1024),
      });
    }

    if (outcome.error) {
      fields.push({
        name: "Error",
        value: `\`\`\`\n${outcome.error.slice(0, 400)}\n\`\`\``,
      });
    }

    return {
      title: `${statusEmoji} Ceremony: ${ceremonyName}`,
      color,
      fields,
      timestamp: ts,
      footer: { text: `Run ID: ${outcome.runId} • protoWorkstacean` },
    };
  }
}

import type { GoalViolation } from "../types/goals.ts";
import { HttpClient } from "../services/http-client.ts";

const SEVERITY_COLORS: Record<string, number> = {
  low: 0x3498db,      // blue
  medium: 0xf39c12,   // orange
  high: 0xe74c3c,     // red
  critical: 0x8e44ad, // purple
};

/**
 * Discord webhook integration for goal violation logging.
 * Uses the DISCORD_GOALS_WEBHOOK_URL environment variable.
 * Falls back to console logging on missing config or network error.
 */
export class DiscordLogger {
  private webhookUrl: string | null;
  private readonly http: HttpClient;

  constructor(webhookUrl?: string) {
    this.webhookUrl = webhookUrl ?? process.env.DISCORD_GOALS_WEBHOOK_URL ?? null;
    this.http = new HttpClient({ timeoutMs: 10_000 });
    if (!this.webhookUrl) {
      console.info("[discord-logger] DISCORD_GOALS_WEBHOOK_URL not set — using console fallback");
    }
  }

  /** Send a goal violation message to Discord. Returns true on success. */
  async logViolation(violation: GoalViolation): Promise<boolean> {
    if (!this.webhookUrl) {
      console.log(`[discord-logger:fallback] Goal violation: [${violation.severity.toUpperCase()}] ${violation.goalId} — ${violation.message}`);
      return false;
    }

    const embed = this._buildEmbed(violation);

    try {
      await this.http.post(this.webhookUrl, { embeds: [embed] });
      return true;
    } catch (err) {
      console.error("[discord-logger] Discord integration error:", err);
      console.log(`[discord-logger:fallback] Goal violation: [${violation.severity.toUpperCase()}] ${violation.goalId} — ${violation.message}`);
      return false;
    }
  }

  private _buildEmbed(violation: GoalViolation): Record<string, unknown> {
    const color = SEVERITY_COLORS[violation.severity] ?? SEVERITY_COLORS.medium;
    const ts = new Date(violation.timestamp).toISOString();

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: "Goal ID", value: `\`${violation.goalId}\``, inline: true },
      { name: "Type", value: violation.goalType, inline: true },
      { name: "Severity", value: violation.severity.toUpperCase(), inline: true },
      { name: "Message", value: violation.message.slice(0, 1024) },
    ];

    if (violation.projectSlug) {
      fields.push({ name: "Project", value: violation.projectSlug, inline: true });
    }

    if (violation.actual !== undefined) {
      const actualStr = JSON.stringify(violation.actual);
      fields.push({
        name: "Actual",
        value: `\`\`\`json\n${actualStr.slice(0, 400)}\n\`\`\``,
      });
    }

    if (violation.expected !== undefined) {
      const expectedStr = JSON.stringify(violation.expected);
      fields.push({
        name: "Expected",
        value: `\`\`\`json\n${expectedStr.slice(0, 400)}\n\`\`\``,
      });
    }

    return {
      title: `Goal Violation: ${violation.description}`,
      color,
      fields,
      timestamp: ts,
      footer: { text: "protoWorkstacean • Goal Evaluator" },
    };
  }
}

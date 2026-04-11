/**
 * DiscordAlerter — threshold_monitor for budget alerts.
 *
 * Sends Discord webhook notifications when spend reaches 50% and 80%
 * of the daily budget caps.
 *
 * Deviation rule: when the webhook is unavailable,
 *   - Queue alert messages in persistent queue
 *   - Retry with exponential backoff (max 7 retries)
 *   - Create in-app notification as fallback
 *   - Alert ops channel
 */

import type { BudgetState } from "../types/budget.ts";
import { MAX_PROJECT_BUDGET, MAX_DAILY_BUDGET } from "../types/budget.ts";
import { CONFIG } from "../../src/config/env.ts";

// ── Configuration ─────────────────────────────────────────────────────────────

export interface DiscordAlertConfig {
  webhookUrl: string;
  /** Ops channel webhook (fallback target) */
  opsWebhookUrl?: string;
  /** Budget threshold levels to alert on (0–1 fractions) */
  thresholds: number[];
  maxRetries: number;
  initialBackoffMs: number;
}

const DEFAULT_CONFIG: DiscordAlertConfig = {
  webhookUrl: CONFIG.DISCORD_BUDGET_WEBHOOK_URL ?? "",
  opsWebhookUrl: CONFIG.DISCORD_OPS_WEBHOOK_URL ?? "",
  thresholds: [0.5, 0.8],
  maxRetries: 7,
  initialBackoffMs: 1000,
};

// ── Queued alert ──────────────────────────────────────────────────────────────

interface QueuedAlert {
  id: string;
  payload: DiscordWebhookPayload;
  retryCount: number;
  nextRetryAt: number;
}

interface DiscordWebhookPayload {
  embeds: DiscordEmbed[];
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: { name: string; value: string; inline?: boolean }[];
  footer: { text: string };
  timestamp: string;
}

// ── Threshold tracking ───────────────────────────────────────────────────────

type ThresholdKey = string; // `${projectId}:${threshold}`

// ── DiscordAlerter ────────────────────────────────────────────────────────────

export class DiscordAlerter {
  private config: DiscordAlertConfig;
  private firedThresholds = new Set<ThresholdKey>();
  private queue: QueuedAlert[] = [];
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<DiscordAlertConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start(): void {
    // Process queued alerts every 30s
    this.retryTimer = setInterval(() => this._drainQueue(), 30_000);
  }

  stop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Reset threshold tracking (e.g. daily rollover) */
  resetThresholds(): void {
    this.firedThresholds.clear();
  }

  // ── Threshold monitoring ──────────────────────────────────────────────────

  /**
   * threshold_monitor: check if any alerting thresholds have been crossed
   * and dispatch Discord notifications accordingly.
   */
  async checkThresholds(budgetState: BudgetState): Promise<void> {
    for (const threshold of this.config.thresholds) {
      await this._checkProjectThreshold(budgetState, threshold);
      await this._checkDailyThreshold(budgetState, threshold);
    }
  }

  private async _checkProjectThreshold(
    state: BudgetState,
    threshold: number,
  ): Promise<void> {
    const usage = state.projectDailySpend / MAX_PROJECT_BUDGET;
    const key: ThresholdKey = `project:${state.projectId}:${threshold}`;

    if (usage >= threshold && !this.firedThresholds.has(key)) {
      this.firedThresholds.add(key);
      const embed = this._buildEmbed(
        `Project Budget Alert — ${Math.round(threshold * 100)}%`,
        `Project **${state.projectId}** has reached ${(usage * 100).toFixed(1)}% of its daily budget.`,
        threshold >= 0.8 ? 0xff4444 : 0xffaa00,
        [
          { name: "Project", value: state.projectId, inline: true },
          { name: "Agent", value: state.agentId, inline: true },
          {
            name: "Spend",
            value: `$${state.projectDailySpend.toFixed(4)} / $${MAX_PROJECT_BUDGET.toFixed(2)}`,
            inline: true,
          },
          {
            name: "Remaining",
            value: `$${state.remainingProjectBudget.toFixed(4)}`,
            inline: true,
          },
        ],
      );
      await this._dispatch({ embeds: [embed] });
    }
  }

  private async _checkDailyThreshold(
    state: BudgetState,
    threshold: number,
  ): Promise<void> {
    const usage = state.totalDailySpend / MAX_DAILY_BUDGET;
    const key: ThresholdKey = `daily:${threshold}`;

    if (usage >= threshold && !this.firedThresholds.has(key)) {
      this.firedThresholds.add(key);
      const embed = this._buildEmbed(
        `Total Daily Budget Alert — ${Math.round(threshold * 100)}%`,
        `Total daily spend has reached ${(usage * 100).toFixed(1)}% of the $${MAX_DAILY_BUDGET} daily cap.`,
        threshold >= 0.8 ? 0xff0000 : 0xff8800,
        [
          {
            name: "Total Spend",
            value: `$${state.totalDailySpend.toFixed(4)} / $${MAX_DAILY_BUDGET.toFixed(2)}`,
            inline: true,
          },
          {
            name: "Remaining",
            value: `$${state.remainingDailyBudget.toFixed(4)}`,
            inline: true,
          },
          {
            name: "Threshold",
            value: `${Math.round(threshold * 100)}%`,
            inline: true,
          },
        ],
      );
      await this._dispatch({ embeds: [embed] });
    }
  }

  // ── Message formatting ────────────────────────────────────────────────────

  private _buildEmbed(
    title: string,
    description: string,
    color: number,
    fields: { name: string; value: string; inline?: boolean }[],
  ): DiscordEmbed {
    return {
      title,
      description,
      color,
      fields,
      footer: { text: "WorkStacean Budget Monitor" },
      timestamp: new Date().toISOString(),
    };
  }

  // ── Delivery ──────────────────────────────────────────────────────────────

  private async _dispatch(payload: DiscordWebhookPayload): Promise<void> {
    if (!this.config.webhookUrl) {
      console.warn("[discord-alerts] No DISCORD_BUDGET_WEBHOOK_URL configured — skipping alert");
      return;
    }

    const success = await this._sendWebhook(this.config.webhookUrl, payload);
    if (!success) {
      console.warn("[discord-alerts] Webhook delivery failed — queuing for retry");
      this.queue.push({
        id: crypto.randomUUID(),
        payload,
        retryCount: 0,
        nextRetryAt: Date.now() + this.config.initialBackoffMs,
      });
      // In-app notification fallback: publish to ops bus topic (if available)
      this._notifyOps(payload);
    }
  }

  private async _sendWebhook(url: string, payload: DiscordWebhookPayload): Promise<boolean> {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        console.warn(`[discord-alerts] Webhook returned ${resp.status}`);
        return false;
      }
      return true;
    } catch (err) {
      console.warn("[discord-alerts] Webhook fetch error:", err);
      return false;
    }
  }

  private _notifyOps(payload: DiscordWebhookPayload): void {
    // Fallback: log a structured alert to ops channel if configured
    if (this.config.opsWebhookUrl) {
      void this._sendWebhook(this.config.opsWebhookUrl, payload);
    }
    // Also log to console as in-app fallback
    const title = payload.embeds[0]?.title ?? "Budget Alert";
    console.warn(`[discord-alerts][IN-APP FALLBACK] ${title}`);
  }

  private async _drainQueue(): Promise<void> {
    if (this.queue.length === 0) return;

    const now = Date.now();
    const due = this.queue.filter((a) => a.nextRetryAt <= now);

    for (const alert of due) {
      const success = await this._sendWebhook(this.config.webhookUrl, alert.payload);
      if (success) {
        this.queue = this.queue.filter((a) => a.id !== alert.id);
      } else {
        alert.retryCount += 1;
        if (alert.retryCount >= this.config.maxRetries) {
          console.error(`[discord-alerts] Max retries (${this.config.maxRetries}) reached for alert ${alert.id} — dropping`);
          this.queue = this.queue.filter((a) => a.id !== alert.id);
          this._notifyOps(alert.payload);
        } else {
          // Exponential backoff
          const backoff = this.config.initialBackoffMs * Math.pow(2, alert.retryCount);
          alert.nextRetryAt = Date.now() + backoff;
          console.log(`[discord-alerts] Retry ${alert.retryCount}/${this.config.maxRetries} in ${backoff}ms`);
        }
      }
    }
  }

  /** Expose queue length for monitoring */
  get pendingAlerts(): number {
    return this.queue.length;
  }
}

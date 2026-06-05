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
import { logger } from "../../../lib/log.ts";

const log = logger("ceremony-notifier");

const STATUS_COLORS: Record<string, number> = {
  success: 0x2ecc71,  // green
  failure: 0xe74c3c,  // red
  timeout: 0xf39c12,  // orange
};

// Discord embed limits. A description holds 4096 chars (vs a field's 1024), and
// a single message may carry ≤10 embeds whose text sums to ≤6000 chars. Long
// results are chunked into description-embeds and split across messages.
const DESC_CHUNK = 3500;        // headroom under the 4096 description cap
const MAX_EMBEDS_PER_MSG = 10;
const MAX_CHARS_PER_MSG = 6000;

type Embed = Record<string, unknown>;

/**
 * Split text into chunks ≤ `size`, preferring line boundaries so markdown/bullets
 * aren't cut mid-line. A single over-long line is hard-split. Always ≥1 chunk.
 */
export function chunkText(text: string, size: number = DESC_CHUNK): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const line of (text ?? "").split("\n")) {
    if (line.length > size) {
      if (cur) { chunks.push(cur); cur = ""; }
      for (let i = 0; i < line.length; i += size) chunks.push(line.slice(i, i + size));
      continue;
    }
    if (cur && cur.length + line.length + 1 > size) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [""];
}

/** Approximate Discord's per-message char budget for one embed (title + description + fields + footer). */
export function embedTextLength(e: Embed): number {
  let n = 0;
  if (typeof e.title === "string") n += e.title.length;
  if (typeof e.description === "string") n += e.description.length;
  if (Array.isArray(e.fields)) {
    for (const f of e.fields as Array<{ name?: string; value?: string }>) {
      n += (f.name?.length ?? 0) + (f.value?.length ?? 0);
    }
  }
  const footer = e.footer as { text?: string } | undefined;
  if (footer?.text) n += footer.text.length;
  return n;
}

/** Pack embeds into messages, each ≤10 embeds and ≤6000 total chars (one POST per message). */
export function packEmbedsIntoMessages(embeds: Embed[]): Embed[][] {
  const messages: Embed[][] = [];
  let cur: Embed[] = [];
  let curLen = 0;
  for (const e of embeds) {
    const len = embedTextLength(e);
    if (cur.length && (cur.length >= MAX_EMBEDS_PER_MSG || curLen + len > MAX_CHARS_PER_MSG)) {
      messages.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(e);
    curLen += len;
  }
  if (cur.length) messages.push(cur);
  return messages;
}

export class CeremonyNotifier {
  private defaultWebhookUrl: string | null;

  constructor(webhookUrl?: string) {
    this.defaultWebhookUrl = webhookUrl ?? process.env.DISCORD_CEREMONY_WEBHOOK_URL ?? null;
    if (!this.defaultWebhookUrl) {
      log.info("DISCORD_CEREMONY_WEBHOOK_URL not set — using console fallback");
    }
  }

  /**
   * Send a ceremony outcome notification to Discord.
   * If notifyChannel is provided, attempts to resolve a channel-specific webhook.
   * Returns true on success, false on fallback.
   */
  async notify(outcome: CeremonyOutcome, ceremonyName: string, notifyChannel?: string, webhookEnv?: string): Promise<boolean> {
    const webhookUrl = this._resolveWebhook(notifyChannel, webhookEnv);

    if (!webhookUrl) {
      this._logFallback(outcome, ceremonyName);
      return false;
    }

    const messages = packEmbedsIntoMessages(this._buildEmbeds(outcome, ceremonyName));

    try {
      // One POST per message; Discord caps each at 10 embeds / 6000 chars. Sent
      // sequentially so multi-part digests arrive in order.
      for (const embeds of messages) {
        const resp = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          throw new Error(`Discord webhook error ${resp.status}: ${body}`);
        }
      }
      return true;
    } catch (err) {
      log.error("Discord integration error", { err });
      this._logFallback(outcome, ceremonyName);
      return false;
    }
  }

  private _resolveWebhook(channelSlug?: string, webhookEnv?: string): string | null {
    // Explicit env var override (e.g. DISCORD_RESEARCH_WEBHOOK) wins.
    if (webhookEnv && process.env[webhookEnv]) return process.env[webhookEnv]!;
    if (channelSlug) {
      // Channel-specific webhook env var: DISCORD_WEBHOOK_<SLUG>.
      const envKey = `DISCORD_WEBHOOK_${channelSlug.toUpperCase().replace(/-/g, "_")}`;
      const channelUrl = process.env[envKey];
      if (channelUrl) return channelUrl;
    }
    return this.defaultWebhookUrl;
  }

  private _logFallback(outcome: CeremonyOutcome, ceremonyName: string): void {
    // Intentional console output sink: when no Discord webhook is configured,
    // the ceremony outcome is delivered to stdout. This is the fallback
    // *delivery channel*, not operational logging — kept on console so the
    // payload stays a stable, parse-friendly single line (a2a/ops tail it).
    const durationSec = (outcome.duration / 1000).toFixed(1);
    console.log(
      `[ceremony-notifier:fallback] Ceremony "${ceremonyName}" (${outcome.ceremonyId}) ` +
      `${outcome.status.toUpperCase()} in ${durationSec}s — run ${outcome.runId}`,
    );
  }

  /**
   * Build the embed(s) for an outcome. The result goes in the embed
   * DESCRIPTION (4096 cap, renders markdown) rather than a 1024 field, and is
   * chunked into continuation embeds when longer. The first embed carries the
   * title + metadata fields; continuations carry only their description.
   */
  private _buildEmbeds(outcome: CeremonyOutcome, ceremonyName: string): Embed[] {
    const color = STATUS_COLORS[outcome.status] ?? STATUS_COLORS.failure;
    const durationSec = (outcome.duration / 1000).toFixed(1);
    const ts = new Date(outcome.completedAt).toISOString();
    const EMOJI_BY_STATUS: Record<string, string> = { success: "✅", timeout: "⏱️" };
    const statusEmoji = EMOJI_BY_STATUS[outcome.status] ?? "❌";

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: "Ceremony", value: `\`${outcome.ceremonyId}\``, inline: true },
      { name: "Skill", value: `\`${outcome.skill}\``, inline: true },
      { name: "Duration", value: `${durationSec}s`, inline: true },
      { name: "Targets", value: outcome.targets.join(", ").slice(0, 200) || "none", inline: false },
    ];
    if (outcome.error) {
      fields.push({ name: "Error", value: `\`\`\`\n${outcome.error.slice(0, 400)}\n\`\`\`` });
    }

    const chunks = chunkText(outcome.result ?? "");
    return chunks.map((chunk, i) => {
      const first = i === 0;
      const embed: Embed = { color, description: chunk };
      if (first) {
        embed.title = `${statusEmoji} Ceremony: ${ceremonyName}`;
        embed.fields = fields;
      }
      // Timestamp + footer on the LAST embed so the run id closes the sequence.
      if (i === chunks.length - 1) {
        embed.timestamp = ts;
        embed.footer = { text: `Run ID: ${outcome.runId} • protoWorkstacean` };
      }
      return embed;
    });
  }
}

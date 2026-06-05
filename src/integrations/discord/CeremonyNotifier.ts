/**
 * CeremonyNotifier — sends ceremony execution outcomes to Discord.
 *
 * Delivers the outcome as a plain MARKDOWN MESSAGE (Discord renders headers,
 * bullets, and blank lines in message content), not an embed — embeds cramped
 * multi-line digests. The skill's result IS the message body; a small `-#`
 * subtext line carries the ceremony/run metadata. Long results split across
 * messages at Discord's 2000-char content cap.
 *
 * Webhook resolution: explicit `webhookEnv` wins, else `notifyChannel` →
 * DISCORD_WEBHOOK_<SLUG>, else DISCORD_CEREMONY_WEBHOOK_URL. Falls back to
 * console when none is configured. Always non-blocking.
 */

import type { CeremonyOutcome } from "../../plugins/CeremonyPlugin.types.ts";
import { logger } from "../../../lib/log.ts";

const log = logger("ceremony-notifier");

// Discord caps a message's `content` at 2000 chars; chunk under that with room
// for the trailing metadata line appended to the last chunk.
const MSG_CHUNK = 1850;

const STATUS_EMOJI: Record<string, string> = { success: "✅", timeout: "⏱️" };

/**
 * Split text into chunks ≤ `size`, preferring line boundaries so markdown
 * (headers/bullets) isn't cut mid-line. A single over-long line is hard-split.
 * Always returns ≥1 chunk.
 */
export function chunkText(text: string, size: number = MSG_CHUNK): string[] {
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

/**
 * Build the message content string(s) for an outcome — the markdown body plus a
 * `-#` metadata subtext on the last message. Pure + exported for testing.
 */
export function buildContentMessages(outcome: CeremonyOutcome, ceremonyName: string): string[] {
  const durationSec = (outcome.duration / 1000).toFixed(1);
  const emoji = STATUS_EMOJI[outcome.status] ?? "❌";
  const meta = `-# ${emoji} \`${outcome.ceremonyId}\` · ${outcome.skill} · ${durationSec}s · run ${outcome.runId.slice(0, 8)}`;

  let body = (outcome.result ?? "").trim();
  if (outcome.status !== "success") {
    const head = `${emoji} **${ceremonyName}** — ${outcome.status}`;
    const errBlock = outcome.error ? `\n\`\`\`\n${outcome.error.slice(0, 1500)}\n\`\`\`` : "";
    body = body ? `${head}${errBlock}\n\n${body}` : `${head}${errBlock}`;
  }
  if (!body) body = `${emoji} **${ceremonyName}** — done`;

  const chunks = chunkText(body, MSG_CHUNK);
  chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n${meta}`;
  return chunks;
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
   * Send a ceremony outcome to Discord as markdown message(s).
   * Returns true on success, false on fallback.
   */
  async notify(outcome: CeremonyOutcome, ceremonyName: string, notifyChannel?: string, webhookEnv?: string): Promise<boolean> {
    const webhookUrl = this._resolveWebhook(notifyChannel, webhookEnv);

    if (!webhookUrl) {
      this._logFallback(outcome, ceremonyName);
      return false;
    }

    try {
      // One POST per message (Discord caps content at 2000 chars); sequential so
      // a multi-part digest arrives in order.
      for (const content of buildContentMessages(outcome, ceremonyName)) {
        const resp = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
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
}

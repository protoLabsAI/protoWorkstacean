/**
 * Google Gmail service — polling inbound messages and publishing to the bus,
 * plus an outbound subscriber that posts replies back via the Gmail API.
 *
 * Inbound topic shape:
 *   message.inbound.google.gmail.{labelSlug}.{threadId}
 *
 *   labelSlug = lowercase, non-alphanumeric → "-" (so `INBOX` → `inbox`,
 *   `Personal/Work` → `personal-work`). RouterPlugin matches against
 *   workspace/channels.yaml entries via ChannelRegistry.findByTopic().
 *
 * Reply path:
 *   reply.topic = google.gmail.reply.{threadId}
 *
 *   Subscriber (createGmailOutbound) POSTs an RFC-822 reply via the Gmail
 *   send endpoint with threadId set so the message lands in the same
 *   conversation. Headers (To/Subject/In-Reply-To/References) come from a
 *   per-thread cache populated at inbound publish time, falling back to a
 *   one-shot Gmail thread fetch when the cache is cold (e.g. after a
 *   process restart).
 */

import type { EventBus, BusMessage } from "../../types.ts";
import { withCircuitBreaker } from "../circuit-breaker.ts";
import { getGoogleAccessToken } from "./auth.ts";

export interface GmailConfig {
  watchLabels: string[];
  pollIntervalMinutes: number;
  routingRules: { label: string; skillHint: string }[];
}

export interface GmailService {
  start(bus: EventBus): void;
  stop(): void;
}

/** Thread-context cache populated on inbound, consumed on outbound reply. */
interface ThreadContext {
  to: string;        // original From — becomes the reply's To
  subject: string;   // original Subject — wrapped in "Re: …" if not already
  inReplyTo: string; // original Message-ID header value
  references: string;
}

const THREAD_CTX = new Map<string, ThreadContext>();
const THREAD_CTX_MAX = 1000;

function rememberThread(threadId: string, ctx: ThreadContext): void {
  THREAD_CTX.set(threadId, ctx);
  if (THREAD_CTX.size > THREAD_CTX_MAX) {
    const [oldest] = THREAD_CTX;
    if (oldest) THREAD_CTX.delete(oldest[0]);
  }
}

function labelSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "-");
}

export function createGmailService(getConfig: () => GmailConfig): GmailService {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let initTimeout: ReturnType<typeof setTimeout> | null = null;

  const processedIds = new Set<string>();
  const maxProcessedIds = 500;

  async function _pollGmail(bus: EventBus): Promise<void> {
    const config = getConfig();
    const labels = config.watchLabels ?? [];
    if (!labels.length) return;

    const token = await getGoogleAccessToken();
    if (!token) return;

    for (const label of labels) {
      try {
        const query = `label:${label.replace(/\s+/g, "-")} is:unread`;
        const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
        url.searchParams.set("q", query);
        url.searchParams.set("maxResults", "10");

        const listResp = await withCircuitBreaker("google-api", () =>
          fetch(url.toString(), {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          }),
        );

        if (!listResp.ok) {
          console.warn(`[google] Gmail list failed for label "${label}": ${listResp.status}`);
          continue;
        }

        const listData = await listResp.json() as { messages?: { id: string; threadId: string }[] };
        const messages = listData.messages ?? [];

        for (const rawMsg of messages) {
          if (processedIds.has(rawMsg.id)) continue;

          const msgResp = await withCircuitBreaker("google-api", () =>
            fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${rawMsg.id}`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(15_000),
            }),
          );
          if (!msgResp.ok) continue;

          const fullMsg = await msgResp.json() as {
            id: string;
            threadId: string;
            payload?: {
              headers?: { name: string; value: string }[];
              body?: { data?: string };
              parts?: { mimeType: string; body?: { data?: string } }[];
            };
          };

          const headers = fullMsg.payload?.headers ?? [];
          const getHeader = (name: string): string =>
            headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

          const parts = fullMsg.payload?.parts ?? [];
          const plainPart = parts.find(p => p.mimeType === "text/plain");
          const rawBody = plainPart?.body?.data ?? fullMsg.payload?.body?.data ?? "";
          const body = rawBody
            ? Buffer.from(rawBody.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
            : "";

          const rule = config.routingRules?.find(r => r.label.toLowerCase() === label.toLowerCase());

          processedIds.add(rawMsg.id);
          if (processedIds.size > maxProcessedIds) {
            const [oldest] = processedIds;
            processedIds.delete(oldest);
          }

          const slug = labelSlug(label);
          const topic = `message.inbound.google.gmail.${slug}.${rawMsg.threadId}`;
          const from = getHeader("From");
          const subject = getHeader("Subject");
          const messageIdHeader = getHeader("Message-ID");
          const referencesHeader = getHeader("References");

          rememberThread(rawMsg.threadId, {
            to: from,
            subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
            inReplyTo: messageIdHeader,
            references: [referencesHeader, messageIdHeader].filter(Boolean).join(" "),
          });

          bus.publish(topic, {
            id: crypto.randomUUID(),
            correlationId: `google-gmail-${rawMsg.threadId}`,
            topic,
            timestamp: Date.now(),
            payload: {
              messageId: rawMsg.id,
              threadId: rawMsg.threadId,
              label,
              labelSlug: slug,
              from,
              to: getHeader("To"),
              subject,
              date: getHeader("Date"),
              body: body.slice(0, 4_000),
              // `content` is the renderable form generic chat agents read.
              content: body.slice(0, 4_000),
              ...(rule?.skillHint ? { skillHint: rule.skillHint } : {}),
            },
            source: {
              interface: "google" as const,
              channelId: slug,
              userId: from,
            },
            reply: {
              topic: `google.gmail.reply.${rawMsg.threadId}`,
              format: "markdown",
            },
          });

          console.log(
            `[google] Gmail: routed message from "${from}" (label: ${label}${rule?.skillHint ? `, skill: ${rule.skillHint}` : ""})`,
          );
        }
      } catch (err) {
        console.error(`[google] Gmail poll error for label "${label}":`, err);
      }
    }
  }

  return {
    start(bus: EventBus) {
      const config = getConfig();
      const labels = config.watchLabels ?? [];
      if (!labels.length) {
        console.log("[google] Gmail polling skipped — no watchLabels configured");
        return;
      }

      const intervalMs = (config.pollIntervalMinutes ?? 5) * 60_000;
      initTimeout = setTimeout(() => _pollGmail(bus), 10_000);
      pollTimer = setInterval(() => _pollGmail(bus), intervalMs);
      console.log(
        `[google] Gmail poller started (interval: ${config.pollIntervalMinutes}m, labels: ${labels.join(", ")})`,
      );
    },

    stop() {
      if (initTimeout) { clearTimeout(initTimeout); initTimeout = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    },
  };
}

// ── Outbound — agent replies → Gmail send ────────────────────────────────────

export interface GmailOutboundService {
  start(bus: EventBus): void;
  stop(): void;
}

interface GmailReplyPayload {
  text?: string;
  content?: string;
  summary?: string;
  // Optional overrides for the Gmail headers — pulled from the cached thread
  // context (or re-fetched from Gmail) when absent.
  to?: string;
  subject?: string;
  inReplyTo?: string;
  references?: string;
}

export function createGmailOutbound(): GmailOutboundService {
  let subId: string | null = null;
  let installedBus: EventBus | null = null;

  return {
    start(bus: EventBus) {
      installedBus = bus;
      subId = bus.subscribe("google.gmail.reply.#", "google-gmail-outbound", async (msg: BusMessage) => {
        try {
          await handleReply(msg);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          console.error(`[google] Gmail reply exception on ${msg.topic}: ${m}`);
        }
      });
      console.log("[google] Gmail outbound subscriber active (google.gmail.reply.#)");
    },
    stop() {
      if (subId && installedBus) {
        installedBus.unsubscribe(subId);
        subId = null;
        installedBus = null;
      }
    },
  };
}

/** URL-safe base64 encode without padding — Gmail send body shape. */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function handleReply(msg: BusMessage): Promise<void> {
  const topic = msg.topic ?? "";
  const threadId = topic.startsWith("google.gmail.reply.")
    ? topic.slice("google.gmail.reply.".length)
    : "";
  if (!threadId) {
    console.warn(`[google] Gmail reply: missing threadId in topic ${topic}`);
    return;
  }

  const payload = (msg.payload ?? {}) as GmailReplyPayload;
  const body = payload.text ?? payload.content ?? payload.summary ?? "";
  if (!body.trim()) {
    console.warn(`[google] Gmail reply on thread ${threadId.slice(0, 12)}…: empty body — skipping`);
    return;
  }

  // Resolve thread headers — payload override > cache > re-fetch.
  let ctx = THREAD_CTX.get(threadId);
  if (!ctx || payload.to || payload.subject || payload.inReplyTo) {
    const fetched = await fetchThreadHeaders(threadId);
    ctx = {
      to: payload.to ?? ctx?.to ?? fetched?.to ?? "",
      subject: payload.subject ?? ctx?.subject ?? fetched?.subject ?? "",
      inReplyTo: payload.inReplyTo ?? ctx?.inReplyTo ?? fetched?.inReplyTo ?? "",
      references: payload.references ?? ctx?.references ?? fetched?.references ?? "",
    };
  }

  if (!ctx.to) {
    console.warn(`[google] Gmail reply on thread ${threadId.slice(0, 12)}…: no recipient resolved — skipping`);
    return;
  }

  const token = await getGoogleAccessToken();
  if (!token) {
    console.warn(`[google] Gmail reply on thread ${threadId.slice(0, 12)}…: no access token — skipping`);
    return;
  }

  const headers: string[] = [
    `To: ${ctx.to}`,
    `Subject: ${ctx.subject || "(no subject)"}`,
  ];
  if (ctx.inReplyTo) headers.push(`In-Reply-To: ${ctx.inReplyTo}`);
  if (ctx.references) headers.push(`References: ${ctx.references}`);
  headers.push("Content-Type: text/plain; charset=utf-8");
  headers.push("MIME-Version: 1.0");
  const raw = headers.join("\r\n") + "\r\n\r\n" + body;
  const encoded = base64url(Buffer.from(raw, "utf-8"));

  const sendResp = await withCircuitBreaker("google-api", () =>
    fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encoded, threadId }),
      signal: AbortSignal.timeout(15_000),
    }),
  );
  if (!sendResp.ok) {
    const errText = await sendResp.text().catch(() => "");
    console.warn(
      `[google] Gmail reply on thread ${threadId.slice(0, 12)}… failed: ${sendResp.status} ${errText.slice(0, 200)}`,
    );
    return;
  }
  console.log(`[google] Gmail reply sent on thread ${threadId.slice(0, 12)}… → ${ctx.to}`);
}

/**
 * Fall-back when the in-process thread cache is cold (e.g. after restart).
 * Fetches the latest message in the thread to recover the From/Subject/
 * Message-ID headers the reply needs to thread correctly.
 */
async function fetchThreadHeaders(threadId: string): Promise<ThreadContext | null> {
  const token = await getGoogleAccessToken();
  if (!token) return null;
  try {
    const resp = await withCircuitBreaker("google-api", () =>
      fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      }),
    );
    if (!resp.ok) return null;
    const data = await resp.json() as {
      messages?: { payload?: { headers?: { name: string; value: string }[] } }[];
    };
    const last = data.messages?.[data.messages.length - 1];
    if (!last) return null;
    const headers = last.payload?.headers ?? [];
    const getHeader = (name: string): string =>
      headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
    const subject = getHeader("Subject");
    const messageId = getHeader("Message-ID");
    const references = getHeader("References");
    return {
      to: getHeader("From"),
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      inReplyTo: messageId,
      references: [references, messageId].filter(Boolean).join(" "),
    };
  } catch {
    return null;
  }
}

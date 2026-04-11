/**
 * Google Gmail service — polling inbound messages and publishing to the bus.
 */

import type { EventBus } from "../../types.ts";
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

export function createGmailService(getConfig: () => GmailConfig): GmailService {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let initTimeout: ReturnType<typeof setTimeout> | null = null;

  // Gmail deduplication: ring-buffer of processed message IDs
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

          // Decode base64url body (Gmail uses URL-safe base64)
          const parts = fullMsg.payload?.parts ?? [];
          const plainPart = parts.find(p => p.mimeType === "text/plain");
          const rawBody = plainPart?.body?.data ?? fullMsg.payload?.body?.data ?? "";
          const body = rawBody
            ? Buffer.from(rawBody.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
            : "";

          // Find skillHint from routing rules
          const rule = config.routingRules?.find(r => r.label.toLowerCase() === label.toLowerCase());

          // Track processed message (ring-buffer eviction)
          processedIds.add(rawMsg.id);
          if (processedIds.size > maxProcessedIds) {
            const [oldest] = processedIds;
            processedIds.delete(oldest);
          }

          bus.publish("message.inbound.google.gmail", {
            id: crypto.randomUUID(),
            correlationId: crypto.randomUUID(),
            topic: "message.inbound.google.gmail",
            timestamp: Date.now(),
            payload: {
              messageId: rawMsg.id,
              threadId: rawMsg.threadId,
              label,
              from: getHeader("From"),
              to: getHeader("To"),
              subject: getHeader("Subject"),
              date: getHeader("Date"),
              body: body.slice(0, 4_000),
              ...(rule?.skillHint ? { skillHint: rule.skillHint } : {}),
            },
            source: { interface: "google" },
          });

          console.log(
            `[google] Gmail: routed message from "${getHeader("From")}" (label: ${label}${rule?.skillHint ? `, skill: ${rule.skillHint}` : ""})`,
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

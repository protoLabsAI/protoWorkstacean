/**
 * Google Docs service — outbound handler (create, insert/update text).
 */

import type { EventBus, BusMessage } from "../../types.ts";
import { withCircuitBreaker } from "../circuit-breaker.ts";
import { getGoogleAccessToken } from "./auth.ts";

export interface DocsService {
  start(bus: EventBus): void;
  stop(): void;
}

export function createDocsService(): DocsService {
  let subId: string | null = null;
  let _busRef: EventBus | null = null;

  function _reply(msg: BusMessage, result: Record<string, unknown>): void {
    const replyTopic = msg.reply?.topic;
    if (!replyTopic || !_busRef) return;
    _busRef.publish(replyTopic, {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: result,
    });
  }

  async function _handleDocsMessage(msg: BusMessage): Promise<void> {
    const payload = msg.payload as Record<string, unknown>;
    const operation = String(payload.operation ?? "create");
    const token = await getGoogleAccessToken();

    if (!token) {
      console.warn("[google] Docs operation skipped — no access token");
      _reply(msg, { success: false, error: "No Google access token available" });
      return;
    }

    try {
      let result: Record<string, unknown>;
      if (operation === "create") {
        result = await _docsCreate(token, payload);
      } else if (operation === "insert" || operation === "update") {
        result = await _docsInsert(token, payload);
      } else {
        result = { success: false, error: `Unknown Docs operation: ${operation}` };
      }
      _reply(msg, result);
    } catch (err) {
      console.error("[google] Docs handler error:", err);
      _reply(msg, { success: false, error: String(err) });
    }
  }

  return {
    start(bus: EventBus) {
      _busRef = bus;
      subId = bus.subscribe("message.outbound.google.docs", "google-docs-outbound", async (msg: BusMessage) => {
        await _handleDocsMessage(msg);
      });
    },

    stop() {
      if (subId && _busRef) {
        _busRef.unsubscribe(subId);
        subId = null;
      }
      _busRef = null;
    },
  };
}

async function _docsCreate(
  token: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const title = String(payload.title ?? "Untitled Document");

  const resp = await withCircuitBreaker("google-api", () =>
    fetch("https://docs.googleapis.com/v1/documents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(15_000),
    }),
  );

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    return { success: false, error: `Docs create failed: ${resp.status} ${errBody}` };
  }

  const data = await resp.json() as { documentId: string; title: string };
  const docLink = `https://docs.google.com/document/d/${data.documentId}/edit`;

  // Insert initial content if provided
  const initialContent = payload.content as string | undefined;
  if (initialContent) {
    await _docsInsert(token, { documentId: data.documentId, content: initialContent });
  }

  return { success: true, documentId: data.documentId, title: data.title, link: docLink };
}

async function _docsInsert(
  token: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const documentId = String(payload.documentId ?? "");
  if (!documentId) return { success: false, error: "documentId required for Docs insert" };

  const content = String(payload.content ?? "");
  const index = typeof payload.index === "number" ? payload.index : 1;

  const resp = await withCircuitBreaker("google-api", () =>
    fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [{ insertText: { location: { index }, text: content } }],
      }),
      signal: AbortSignal.timeout(15_000),
    }),
  );

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    return { success: false, error: `Docs insert failed: ${resp.status} ${errBody}` };
  }

  const docLink = `https://docs.google.com/document/d/${documentId}/edit`;
  return { success: true, documentId, link: docLink };
}

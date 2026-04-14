/**
 * Google Drive service — outbound handler (create, update, append)
 * and createDriveFolder() utility used by OnboardingPlugin.
 */

import type { EventBus, BusMessage } from "../../types.ts";
import { withCircuitBreaker } from "../circuit-breaker.ts";
import { getGoogleAccessToken } from "./auth.ts";

export interface DriveService {
  start(bus: EventBus): void;
  stop(): void;
}

export function createDriveService(): DriveService {
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

  async function _handleDriveMessage(msg: BusMessage): Promise<void> {
    const payload = msg.payload as Record<string, unknown>;
    const operation = String(payload.operation ?? "create");
    const token = await getGoogleAccessToken();

    if (!token) {
      console.warn("[google] Drive operation skipped — no access token");
      _reply(msg, { success: false, error: "No Google access token available" });
      return;
    }

    try {
      let result: Record<string, unknown>;
      if (operation === "create") {
        result = await _driveCreate(token, payload);
      } else if (operation === "update" || operation === "append") {
        result = await _driveUpdate(token, payload, operation === "append");
      } else {
        result = { success: false, error: `Unknown Drive operation: ${operation}` };
      }
      _reply(msg, result);
    } catch (err) {
      console.error("[google] Drive handler error:", err);
      _reply(msg, { success: false, error: String(err) });
    }
  }

  return {
    start(bus: EventBus) {
      _busRef = bus;
      subId = bus.subscribe("message.outbound.google.drive", "google-drive-outbound", async (msg: BusMessage) => {
        await _handleDriveMessage(msg);
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

async function _driveCreate(
  token: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const name = String(payload.name ?? "Untitled");
  const mimeType = String(payload.mimeType ?? "application/octet-stream");
  const parentId = payload.parentId as string | undefined;
  const content = payload.content as string | undefined;

  const metadata: Record<string, unknown> = { name, mimeType };
  if (parentId) metadata.parents = [parentId];

  if (content) {
    // Multipart upload when content is provided
    const boundary = "workstacean_boundary";
    const body =
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n` +
      content +
      `\r\n--${boundary}--`;

    const resp = await withCircuitBreaker("google-api", () =>
      fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary="${boundary}"`,
        },
        body,
        signal: AbortSignal.timeout(30_000),
      }),
    );

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      return { success: false, error: `Drive create failed: ${resp.status} ${errBody}` };
    }
    const data = await resp.json() as { id: string; name: string; webViewLink?: string };
    return { success: true, fileId: data.id, name: data.name, webViewLink: data.webViewLink };
  }

  // Metadata-only create (folder, or file without content)
  const resp = await withCircuitBreaker("google-api", () =>
    fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(15_000),
    }),
  );

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    return { success: false, error: `Drive create failed: ${resp.status} ${errBody}` };
  }
  const data = await resp.json() as { id: string; name: string; webViewLink?: string };
  return { success: true, fileId: data.id, name: data.name, webViewLink: data.webViewLink };
}

async function _driveUpdate(
  token: string,
  payload: Record<string, unknown>,
  append: boolean,
): Promise<Record<string, unknown>> {
  const fileId = String(payload.fileId ?? "");
  if (!fileId) return { success: false, error: "fileId required for Drive update/append" };

  const content = payload.content as string | undefined;
  if (content === undefined) return { success: false, error: "content required for Drive update/append" };

  let body = content;
  if (append) {
    const fetchResp = await withCircuitBreaker("google-api", () =>
      fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      }),
    );
    if (fetchResp.ok) {
      const existing = await fetchResp.text();
      body = existing + content;
    }
  }

  const resp = await withCircuitBreaker("google-api", () =>
    fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body,
      signal: AbortSignal.timeout(30_000),
    }),
  );

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    return { success: false, error: `Drive update failed: ${resp.status} ${errBody}` };
  }
  const data = await resp.json() as { id: string; name: string };
  return { success: true, fileId: data.id, name: data.name };
}

/**
 * Creates a Drive folder with the given name under the specified parent folder.
 * Returns the new folder's id and name, or null on failure.
 * Used by OnboardingPlugin.
 */
export async function createDriveFolder(
  name: string,
  parentId: string,
): Promise<{ id: string; name: string } | null> {
  if (!parentId) {
    console.warn("[google] createDriveFolder: parentId is empty — skipping");
    return null;
  }

  const token = await getGoogleAccessToken();
  if (!token) {
    console.warn("[google] createDriveFolder: no access token available");
    return null;
  }

  try {
    const resp = await withCircuitBreaker("google-api", () =>
      fetch("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentId],
        }),
        signal: AbortSignal.timeout(15_000),
      }),
    );

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      console.error(`[google] Drive folder creation failed: ${resp.status} ${errBody}`);
      return null;
    }

    const data = await resp.json() as { id: string; name: string };
    console.log(`[google] Drive folder created: "${data.name}" (${data.id})`);
    return data;
  } catch (err) {
    console.error("[google] Drive folder creation error:", err);
    return null;
  }
}

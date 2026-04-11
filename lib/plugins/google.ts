/**
 * GooglePlugin — integrates Google Workspace services (Gmail, Drive, Calendar, Docs)
 * with the Workstacean bus.
 *
 * Inbound (via polling):
 *   Gmail messages matching configured labels → message.inbound.google.gmail
 *   Calendar events within 7 days           → message.inbound.google.calendar
 *
 * Outbound (bus subscriptions):
 *   message.outbound.google.drive → Drive file operations (create, update, append)
 *   message.outbound.google.docs  → Docs operations (create, insert text)
 *
 * Config: workspace/google.yaml (hot-reloaded on change)
 *
 * Env vars (all required; injected from Infisical at runtime):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EventBus, BusMessage, Plugin } from "../types.ts";
import { withCircuitBreaker } from "./circuit-breaker.ts";
import { CONFIG } from "../../src/config/env.ts";

// ── Config types ──────────────────────────────────────────────────────────────

interface RoutingRule {
  label: string;
  skillHint: string;
}

interface GoogleConfig {
  drive: {
    orgFolderId: string;
    templateFolderId: string;
  };
  calendar: {
    orgCalendarId: string;
    pollIntervalMinutes: number;
  };
  gmail: {
    watchLabels: string[];
    pollIntervalMinutes: number;
    routingRules: RoutingRule[];
  };
}

function loadConfig(workspaceDir: string): GoogleConfig {
  const configPath = join(workspaceDir, "google.yaml");
  if (!existsSync(configPath)) {
    console.log("[google] No google.yaml found — using defaults");
    return defaultConfig();
  }
  try {
    return parseYaml(readFileSync(configPath, "utf8")) as GoogleConfig;
  } catch (err) {
    console.error("[google] Failed to parse google.yaml:", err);
    return defaultConfig();
  }
}

function defaultConfig(): GoogleConfig {
  return {
    drive: { orgFolderId: "", templateFolderId: "" },
    calendar: { orgCalendarId: "", pollIntervalMinutes: 60 },
    gmail: { watchLabels: [], pollIntervalMinutes: 5, routingRules: [] },
  };
}

// ── OAuth2 token management ───────────────────────────────────────────────────

interface TokenState {
  accessToken: string;
  expiresAt: number; // ms since epoch
}

// Module-level token cache — shared across all imports of this module.
let _tokenState: TokenState | null = null;

/**
 * Returns a valid Google access token, refreshing if needed.
 * Returns null if credentials are not configured or refresh fails.
 * Exported so OnboardingPlugin can reuse the same token cache.
 */
export async function getGoogleAccessToken(): Promise<string | null> {
  const clientId = CONFIG.GOOGLE_CLIENT_ID;
  const clientSecret = CONFIG.GOOGLE_CLIENT_SECRET;
  const refreshToken = CONFIG.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) return null;

  // Return cached token if still valid (with 5-minute buffer)
  if (_tokenState && Date.now() < _tokenState.expiresAt - 300_000) {
    return _tokenState.accessToken;
  }

  return _doTokenRefresh(clientId, clientSecret, refreshToken);
}

async function _doTokenRefresh(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string | null> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        console.error(`[google] Token refresh failed (attempt ${attempt}): ${resp.status} ${errBody}`);
        if (attempt < 3) await _sleep(1_000 * attempt);
        continue;
      }

      const data = await resp.json() as { access_token: string; expires_in: number };
      _tokenState = {
        accessToken: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1_000,
      };
      console.log(`[google] Access token refreshed (expires in ${data.expires_in}s)`);
      return _tokenState.accessToken;
    } catch (err) {
      console.error(`[google] Token refresh error (attempt ${attempt}):`, err);
      if (attempt < 3) await _sleep(1_000 * attempt);
    }
  }
  return null;
}

// ── Drive API helpers (exported for use by OnboardingPlugin) ──────────────────

/**
 * Creates a Drive folder with the given name under the specified parent folder.
 * Returns the new folder's id and name, or null on failure.
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

// ── Plugin ────────────────────────────────────────────────────────────────────

export class GooglePlugin implements Plugin {
  readonly name = "google";
  readonly description = "Google Workspace integration — Gmail, Drive, Calendar, Docs";
  readonly capabilities = ["google-gmail", "google-drive", "google-calendar", "google-docs"];

  private config!: GoogleConfig;
  private workspaceDir: string;
  private busRef!: EventBus;

  // Polling state
  private gmailPollTimer: ReturnType<typeof setInterval> | null = null;
  private gmailInitTimeout: ReturnType<typeof setTimeout> | null = null;
  private calendarPollTimer: ReturnType<typeof setInterval> | null = null;
  private calendarInitTimeout: ReturnType<typeof setTimeout> | null = null;
  private tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;

  // Gmail deduplication: ring-buffer of processed message IDs
  private processedGmailIds = new Set<string>();
  private readonly maxProcessedIds = 500;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  install(bus: EventBus): void {
    if (!CONFIG.GOOGLE_CLIENT_ID || !CONFIG.GOOGLE_CLIENT_SECRET || !CONFIG.GOOGLE_REFRESH_TOKEN) {
      console.log("[google] GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN not set — plugin disabled");
      return;
    }

    this.busRef = bus;
    this.config = loadConfig(this.workspaceDir);

    // ── Outbound: Drive file operations ──────────────────────────────────────
    bus.subscribe("message.outbound.google.drive", "google-drive-outbound", async (msg: BusMessage) => {
      await this._handleDriveMessage(msg);
    });

    // ── Outbound: Docs operations ─────────────────────────────────────────────
    bus.subscribe("message.outbound.google.docs", "google-docs-outbound", async (msg: BusMessage) => {
      await this._handleDocsMessage(msg);
    });

    // ── Gmail polling ─────────────────────────────────────────────────────────
    this._startGmailPoller(bus);

    // ── Calendar polling ──────────────────────────────────────────────────────
    this._startCalendarPoller(bus);

    // ── Token refresh background job ──────────────────────────────────────────
    this._startTokenRefresher();

    // ── Hot-reload google.yaml ────────────────────────────────────────────────
    const configPath = join(this.workspaceDir, "google.yaml");
    watchFile(configPath, { interval: 1_000 }, () => {
      console.log("[google] google.yaml changed — reloading config");
      const prevGmailLabels = JSON.stringify(this.config.gmail?.watchLabels ?? []);
      const prevGmailInterval = this.config.gmail?.pollIntervalMinutes;
      const prevCalInterval = this.config.calendar?.pollIntervalMinutes;

      this.config = loadConfig(this.workspaceDir);

      // Restart Gmail poller if labels or interval changed
      const newGmailLabels = JSON.stringify(this.config.gmail?.watchLabels ?? []);
      if (prevGmailLabels !== newGmailLabels || prevGmailInterval !== this.config.gmail?.pollIntervalMinutes) {
        this._stopGmailPoller();
        this._startGmailPoller(bus);
      }

      // Restart Calendar poller if interval changed
      if (prevCalInterval !== this.config.calendar?.pollIntervalMinutes) {
        this._stopCalendarPoller();
        this._startCalendarPoller(bus);
      }

      bus.publish("config.updated", {
        id: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        topic: "config.updated",
        timestamp: Date.now(),
        payload: { plugin: "google", config: "google.yaml" },
      });

      console.log("[google] google.yaml reloaded");
    });

    console.log("[google] Plugin installed — Drive, Docs, Gmail, Calendar active");
  }

  uninstall(): void {
    this._stopGmailPoller();
    this._stopCalendarPoller();
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    unwatchFile(join(this.workspaceDir, "google.yaml"));
    console.log("[google] Plugin uninstalled");
  }

  // ── Drive outbound handler ────────────────────────────────────────────────────

  private async _handleDriveMessage(msg: BusMessage): Promise<void> {
    const payload = msg.payload as Record<string, unknown>;
    const operation = String(payload.operation ?? "create");
    const token = await getGoogleAccessToken();

    if (!token) {
      console.warn("[google] Drive operation skipped — no access token");
      this._reply(msg, { success: false, error: "No Google access token available" });
      return;
    }

    try {
      let result: Record<string, unknown>;
      if (operation === "create") {
        result = await this._driveCreate(token, payload);
      } else if (operation === "update" || operation === "append") {
        result = await this._driveUpdate(token, payload, operation === "append");
      } else {
        result = { success: false, error: `Unknown Drive operation: ${operation}` };
      }
      this._reply(msg, result);
    } catch (err) {
      console.error("[google] Drive handler error:", err);
      this._reply(msg, { success: false, error: String(err) });
    }
  }

  private async _driveCreate(
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
        fetch(
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": `multipart/related; boundary="${boundary}"`,
            },
            body,
            signal: AbortSignal.timeout(30_000),
          },
        ),
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

  private async _driveUpdate(
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
        fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
        ),
      );
      if (fetchResp.ok) {
        const existing = await fetchResp.text();
        body = existing + content;
      }
    }

    const resp = await withCircuitBreaker("google-api", () =>
      fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "text/plain",
          },
          body,
          signal: AbortSignal.timeout(30_000),
        },
      ),
    );

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      return { success: false, error: `Drive update failed: ${resp.status} ${errBody}` };
    }
    const data = await resp.json() as { id: string; name: string };
    return { success: true, fileId: data.id, name: data.name };
  }

  // ── Docs outbound handler ─────────────────────────────────────────────────────

  private async _handleDocsMessage(msg: BusMessage): Promise<void> {
    const payload = msg.payload as Record<string, unknown>;
    const operation = String(payload.operation ?? "create");
    const token = await getGoogleAccessToken();

    if (!token) {
      console.warn("[google] Docs operation skipped — no access token");
      this._reply(msg, { success: false, error: "No Google access token available" });
      return;
    }

    try {
      let result: Record<string, unknown>;
      if (operation === "create") {
        result = await this._docsCreate(token, payload);
      } else if (operation === "insert" || operation === "update") {
        result = await this._docsInsert(token, payload);
      } else {
        result = { success: false, error: `Unknown Docs operation: ${operation}` };
      }
      this._reply(msg, result);
    } catch (err) {
      console.error("[google] Docs handler error:", err);
      this._reply(msg, { success: false, error: String(err) });
    }
  }

  private async _docsCreate(
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
      await this._docsInsert(token, { documentId: data.documentId, content: initialContent });
    }

    return { success: true, documentId: data.documentId, title: data.title, link: docLink };
  }

  private async _docsInsert(
    token: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const documentId = String(payload.documentId ?? "");
    if (!documentId) return { success: false, error: "documentId required for Docs insert" };

    const content = String(payload.content ?? "");
    const index = typeof payload.index === "number" ? payload.index : 1;

    const resp = await withCircuitBreaker("google-api", () =>
      fetch(
        `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            requests: [{ insertText: { location: { index }, text: content } }],
          }),
          signal: AbortSignal.timeout(15_000),
        },
      ),
    );

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      return { success: false, error: `Docs insert failed: ${resp.status} ${errBody}` };
    }

    const docLink = `https://docs.google.com/document/d/${documentId}/edit`;
    return { success: true, documentId, link: docLink };
  }

  // ── Gmail polling ─────────────────────────────────────────────────────────────

  private _startGmailPoller(bus: EventBus): void {
    const labels = this.config.gmail?.watchLabels ?? [];
    if (!labels.length) {
      console.log("[google] Gmail polling skipped — no watchLabels configured");
      return;
    }

    const intervalMs = (this.config.gmail.pollIntervalMinutes ?? 5) * 60_000;

    // Delay initial poll by 10s to allow token init
    this.gmailInitTimeout = setTimeout(() => this._pollGmail(bus), 10_000);
    this.gmailPollTimer = setInterval(() => this._pollGmail(bus), intervalMs);
    console.log(
      `[google] Gmail poller started (interval: ${this.config.gmail.pollIntervalMinutes}m, labels: ${labels.join(", ")})`,
    );
  }

  private _stopGmailPoller(): void {
    if (this.gmailInitTimeout) {
      clearTimeout(this.gmailInitTimeout);
      this.gmailInitTimeout = null;
    }
    if (this.gmailPollTimer) {
      clearInterval(this.gmailPollTimer);
      this.gmailPollTimer = null;
    }
  }

  private async _pollGmail(bus: EventBus): Promise<void> {
    const labels = this.config.gmail?.watchLabels ?? [];
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
          if (this.processedGmailIds.has(rawMsg.id)) continue;

          const msgResp = await withCircuitBreaker("google-api", () =>
            fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${rawMsg.id}`,
              { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
            ),
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
          const rule = this.config.gmail.routingRules?.find(
            r => r.label.toLowerCase() === label.toLowerCase(),
          );

          // Track processed message (ring-buffer eviction)
          this.processedGmailIds.add(rawMsg.id);
          if (this.processedGmailIds.size > this.maxProcessedIds) {
            const [oldest] = this.processedGmailIds;
            this.processedGmailIds.delete(oldest);
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

  // ── Calendar polling ──────────────────────────────────────────────────────────

  private _startCalendarPoller(bus: EventBus): void {
    const calendarId = this.config.calendar?.orgCalendarId;
    if (!calendarId) {
      console.log("[google] Calendar polling skipped — no orgCalendarId configured");
      return;
    }

    const intervalMs = (this.config.calendar.pollIntervalMinutes ?? 60) * 60_000;

    // Delay initial poll by 15s
    this.calendarInitTimeout = setTimeout(() => this._pollCalendar(bus), 15_000);
    this.calendarPollTimer = setInterval(() => this._pollCalendar(bus), intervalMs);
    console.log(`[google] Calendar poller started (interval: ${this.config.calendar.pollIntervalMinutes}m)`);
  }

  private _stopCalendarPoller(): void {
    if (this.calendarInitTimeout) {
      clearTimeout(this.calendarInitTimeout);
      this.calendarInitTimeout = null;
    }
    if (this.calendarPollTimer) {
      clearInterval(this.calendarPollTimer);
      this.calendarPollTimer = null;
    }
  }

  private async _pollCalendar(bus: EventBus): Promise<void> {
    const calendarId = this.config.calendar?.orgCalendarId;
    if (!calendarId) return;

    const token = await getGoogleAccessToken();
    if (!token) return;

    try {
      const now = new Date();
      const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);

      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      );
      url.searchParams.set("timeMin", now.toISOString());
      url.searchParams.set("timeMax", sevenDays.toISOString());
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", "20");

      const resp = await withCircuitBreaker("google-api", () =>
        fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        }),
      );

      if (!resp.ok) {
        console.warn(`[google] Calendar list failed: ${resp.status}`);
        return;
      }

      const data = await resp.json() as {
        items?: {
          id: string;
          summary?: string;
          description?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
          attendees?: { email: string; displayName?: string }[];
          htmlLink?: string;
        }[];
      };

      const events = data.items ?? [];
      if (!events.length) return;

      bus.publish("message.inbound.google.calendar", {
        id: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        topic: "message.inbound.google.calendar",
        timestamp: Date.now(),
        payload: {
          events: events.map(e => ({
            id: e.id,
            title: e.summary ?? "(No title)",
            description: e.description ?? "",
            start: e.start?.dateTime ?? e.start?.date ?? "",
            end: e.end?.dateTime ?? e.end?.date ?? "",
            attendees: (e.attendees ?? []).map(a => a.email),
            link: e.htmlLink ?? "",
          })),
          window: { from: now.toISOString(), to: sevenDays.toISOString() },
        },
        source: { interface: "google" },
      });

      console.log(`[google] Calendar: published ${events.length} event(s) within next 7 days`);
    } catch (err) {
      console.error("[google] Calendar poll error:", err);
    }
  }

  // ── Token refresh background job ──────────────────────────────────────────────

  private _startTokenRefresher(): void {
    // Check every 60 minutes; refresh proactively when within 10 minutes of expiry.
    this.tokenRefreshTimer = setInterval(async () => {
      if (!_tokenState) return;

      const timeToExpiry = _tokenState.expiresAt - Date.now();
      if (timeToExpiry < 10 * 60_000) {
        console.log("[google] Access token nearing expiry — refreshing proactively");
        const newToken = await getGoogleAccessToken();
        if (!newToken) {
          console.error("[google] Proactive token refresh failed — publishing auth.token_refresh_failed");
          this.busRef.publish("auth.token_refresh_failed", {
            id: crypto.randomUUID(),
            correlationId: crypto.randomUUID(),
            topic: "auth.token_refresh_failed",
            timestamp: Date.now(),
            payload: { plugin: "google", reason: "Token refresh failed after 3 retries" },
          });
        }
      }
    }, 60 * 60_000);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private _reply(msg: BusMessage, result: Record<string, unknown>): void {
    const replyTopic = msg.reply?.topic;
    if (!replyTopic) return;

    this.busRef.publish(replyTopic, {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: result,
    });
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

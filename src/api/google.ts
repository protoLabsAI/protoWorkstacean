/**
 * Google Workspace API routes — back the Ava-side tools that read Gmail
 * and Calendar on demand and create draft replies (no auto-send).
 *
 * Endpoints:
 *   GET  /api/google/gmail/list-unread?label=INBOX&max=20
 *   GET  /api/google/gmail/search?q=from:foo&max=20
 *   GET  /api/google/gmail/thread/:threadId
 *   POST /api/google/gmail/draft   { threadId, body, to?, subject?, inReplyTo?, references? }
 *   GET  /api/google/calendar/upcoming?days=7&calendarId=primary
 *   GET  /api/google/calendar/event/:eventId?calendarId=primary
 *
 * Every endpoint requires the GooglePlugin's OAuth credentials
 * (GOOGLE_CLIENT_ID / SECRET / REFRESH_TOKEN). When unset, returns 503
 * with a clear "google plugin disabled" message so Ava's tool layer can
 * surface the gap without crashing.
 *
 * Ava is a pull-mode reader/drafter: she calls these when explicitly
 * asked. Drafts are NOT sent — they land in the user's Drafts folder for
 * manual review and send.
 */

import type { Route, ApiContext } from "./types.ts";
import { getGoogleAccessToken } from "../../lib/plugins/google/auth.ts";

function disabledResponse(): Response {
  return Response.json(
    {
      success: false,
      error: "Google Workspace plugin disabled — GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN env vars are required.",
    },
    { status: 503 },
  );
}

async function withToken<T>(handler: (token: string) => Promise<T>): Promise<Response> {
  const token = await getGoogleAccessToken();
  if (!token) return disabledResponse();
  try {
    const data = await handler(token);
    return Response.json({ success: true, data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ success: false, error: msg }, { status: 500 });
  }
}

/** Decode Gmail's URL-safe base64 payload to UTF-8 text. */
function decodeBody(data: string | undefined): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

interface GmailMessageHeader { name: string; value: string }
interface GmailMessage {
  id: string;
  threadId: string;
  payload?: {
    headers?: GmailMessageHeader[];
    body?: { data?: string };
    parts?: { mimeType: string; body?: { data?: string } }[];
  };
  snippet?: string;
}

function header(headers: GmailMessageHeader[] | undefined, name: string): string {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractBody(msg: GmailMessage): string {
  const parts = msg.payload?.parts ?? [];
  const plain = parts.find(p => p.mimeType === "text/plain");
  return decodeBody(plain?.body?.data ?? msg.payload?.body?.data);
}

/** Compact summary used by list endpoints. */
function summaryOf(msg: GmailMessage) {
  const headers = msg.payload?.headers;
  return {
    messageId: msg.id,
    threadId: msg.threadId,
    from: header(headers, "From"),
    to: header(headers, "To"),
    subject: header(headers, "Subject"),
    date: header(headers, "Date"),
    snippet: (msg.snippet ?? "").slice(0, 200),
  };
}

async function fetchMessages(token: string, ids: { id: string }[]): Promise<GmailMessage[]> {
  const out: GmailMessage[] = [];
  for (const { id } of ids) {
    const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) continue;
    out.push(await resp.json() as GmailMessage);
  }
  return out;
}

/** Base64URL encode (no padding) — Gmail draft / send body shape. */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createRoutes(_ctx: ApiContext): Route[] {
  return [
    // ── Gmail: list unread ───────────────────────────────────────────────
    {
      method: "GET",
      path: "/api/google/gmail/list-unread",
      handler: async (req) => {
        const url = new URL(req.url);
        const label = url.searchParams.get("label") ?? "INBOX";
        const max = Math.min(parseInt(url.searchParams.get("max") ?? "20", 10) || 20, 100);
        return withToken(async (token) => {
          const query = `label:${label.replace(/\s+/g, "-")} is:unread`;
          const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
          listUrl.searchParams.set("q", query);
          listUrl.searchParams.set("maxResults", String(max));
          const listResp = await fetch(listUrl.toString(), {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          });
          if (!listResp.ok) throw new Error(`Gmail list failed: ${listResp.status}`);
          const listData = await listResp.json() as { messages?: { id: string }[] };
          const messages = await fetchMessages(token, listData.messages ?? []);
          return { label, count: messages.length, messages: messages.map(summaryOf) };
        });
      },
    },

    // ── Gmail: search ────────────────────────────────────────────────────
    {
      method: "GET",
      path: "/api/google/gmail/search",
      handler: async (req) => {
        const url = new URL(req.url);
        const q = url.searchParams.get("q") ?? "";
        const max = Math.min(parseInt(url.searchParams.get("max") ?? "20", 10) || 20, 100);
        if (!q.trim()) {
          return Response.json({ success: false, error: "missing q parameter" }, { status: 400 });
        }
        return withToken(async (token) => {
          const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
          listUrl.searchParams.set("q", q);
          listUrl.searchParams.set("maxResults", String(max));
          const listResp = await fetch(listUrl.toString(), {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          });
          if (!listResp.ok) throw new Error(`Gmail search failed: ${listResp.status}`);
          const listData = await listResp.json() as { messages?: { id: string }[] };
          const messages = await fetchMessages(token, listData.messages ?? []);
          return { query: q, count: messages.length, messages: messages.map(summaryOf) };
        });
      },
    },

    // ── Gmail: get full thread ───────────────────────────────────────────
    {
      method: "GET",
      path: "/api/google/gmail/thread/:threadId",
      handler: async (_req, params) => {
        const threadId = params?.threadId;
        if (!threadId) {
          return Response.json({ success: false, error: "missing threadId" }, { status: 400 });
        }
        return withToken(async (token) => {
          const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          });
          if (!resp.ok) throw new Error(`Gmail thread fetch failed: ${resp.status}`);
          const data = await resp.json() as { messages?: GmailMessage[] };
          const messages = (data.messages ?? []).map(m => ({
            messageId: m.id,
            threadId: m.threadId,
            from: header(m.payload?.headers, "From"),
            to: header(m.payload?.headers, "To"),
            subject: header(m.payload?.headers, "Subject"),
            date: header(m.payload?.headers, "Date"),
            messageIdHeader: header(m.payload?.headers, "Message-ID"),
            references: header(m.payload?.headers, "References"),
            snippet: (m.snippet ?? "").slice(0, 200),
            body: extractBody(m).slice(0, 8_000),
          }));
          return { threadId, count: messages.length, messages };
        });
      },
    },

    // ── Gmail: create draft ──────────────────────────────────────────────
    // Drafts go to Drafts folder. They are NOT sent. Operator reviews + sends.
    {
      method: "POST",
      path: "/api/google/gmail/draft",
      handler: async (req) => {
        let input: {
          threadId?: string;
          body?: string;
          to?: string;
          subject?: string;
          inReplyTo?: string;
          references?: string;
        };
        try {
          input = await req.json() as typeof input;
        } catch {
          return Response.json({ success: false, error: "invalid JSON body" }, { status: 400 });
        }
        if (!input.body?.trim()) {
          return Response.json({ success: false, error: "missing body" }, { status: 400 });
        }
        return withToken(async (token) => {
          // If threadId is set but headers aren't provided, fetch them so the
          // draft threads correctly in Gmail's UI.
          let to = input.to ?? "";
          let subject = input.subject ?? "";
          let inReplyTo = input.inReplyTo ?? "";
          let references = input.references ?? "";
          if (input.threadId && (!to || !subject || !inReplyTo)) {
            const threadResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${input.threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(15_000),
            });
            if (threadResp.ok) {
              const data = await threadResp.json() as { messages?: GmailMessage[] };
              const last = data.messages?.[data.messages.length - 1];
              const h = last?.payload?.headers;
              if (h) {
                if (!to) to = header(h, "From");
                if (!subject) {
                  const s = header(h, "Subject");
                  subject = s.startsWith("Re:") ? s : `Re: ${s}`;
                }
                if (!inReplyTo) inReplyTo = header(h, "Message-ID");
                if (!references) {
                  const refs = header(h, "References");
                  const mid = header(h, "Message-ID");
                  references = [refs, mid].filter(Boolean).join(" ");
                }
              }
            }
          }
          if (!to) {
            throw new Error("draft missing recipient — provide `to` or a `threadId` we can resolve from");
          }

          const headers: string[] = [
            `To: ${to}`,
            `Subject: ${subject || "(no subject)"}`,
          ];
          if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
          if (references) headers.push(`References: ${references}`);
          headers.push("Content-Type: text/plain; charset=utf-8");
          headers.push("MIME-Version: 1.0");
          const raw = headers.join("\r\n") + "\r\n\r\n" + input.body;
          const encoded = base64url(Buffer.from(raw, "utf-8"));

          const draftResp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: input.threadId
                ? { raw: encoded, threadId: input.threadId }
                : { raw: encoded },
            }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!draftResp.ok) {
            const errText = await draftResp.text().catch(() => "");
            throw new Error(`Gmail draft create failed: ${draftResp.status} ${errText.slice(0, 200)}`);
          }
          const draft = await draftResp.json() as { id?: string; message?: { id?: string; threadId?: string } };
          return {
            draftId: draft.id,
            messageId: draft.message?.id,
            threadId: draft.message?.threadId,
            to,
            subject,
            // Sentinel field so callers (and Ava) know to surface "review and send manually."
            sent: false,
          };
        });
      },
    },

    // ── Calendar: upcoming events ────────────────────────────────────────
    {
      method: "GET",
      path: "/api/google/calendar/upcoming",
      handler: async (req) => {
        const url = new URL(req.url);
        const days = Math.min(parseInt(url.searchParams.get("days") ?? "7", 10) || 7, 90);
        const calendarId = url.searchParams.get("calendarId") ?? "primary";
        return withToken(async (token) => {
          const now = new Date();
          const horizon = new Date(now.getTime() + days * 24 * 60 * 60 * 1_000);
          const evtUrl = new URL(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
          );
          evtUrl.searchParams.set("timeMin", now.toISOString());
          evtUrl.searchParams.set("timeMax", horizon.toISOString());
          evtUrl.searchParams.set("singleEvents", "true");
          evtUrl.searchParams.set("orderBy", "startTime");
          evtUrl.searchParams.set("maxResults", "50");
          const resp = await fetch(evtUrl.toString(), {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          });
          if (!resp.ok) throw new Error(`Calendar list failed: ${resp.status}`);
          const data = await resp.json() as {
            items?: {
              id: string;
              summary?: string;
              start?: { dateTime?: string; date?: string };
              end?: { dateTime?: string; date?: string };
              attendees?: { email: string; displayName?: string }[];
              location?: string;
              htmlLink?: string;
            }[];
          };
          const events = (data.items ?? []).map(e => ({
            id: e.id,
            title: e.summary ?? "(No title)",
            start: e.start?.dateTime ?? e.start?.date ?? "",
            end: e.end?.dateTime ?? e.end?.date ?? "",
            attendees: (e.attendees ?? []).map(a => a.email),
            location: e.location ?? "",
            link: e.htmlLink ?? "",
          }));
          return { calendarId, days, count: events.length, events };
        });
      },
    },

    // ── Calendar: event detail ───────────────────────────────────────────
    {
      method: "GET",
      path: "/api/google/calendar/event/:eventId",
      handler: async (req, params) => {
        const url = new URL(req.url);
        const eventId = params?.eventId;
        const calendarId = url.searchParams.get("calendarId") ?? "primary";
        if (!eventId) {
          return Response.json({ success: false, error: "missing eventId" }, { status: 400 });
        }
        return withToken(async (token) => {
          const evtUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
          const resp = await fetch(evtUrl, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          });
          if (!resp.ok) throw new Error(`Calendar event fetch failed: ${resp.status}`);
          const e = await resp.json() as {
            id: string;
            summary?: string;
            description?: string;
            start?: { dateTime?: string; date?: string };
            end?: { dateTime?: string; date?: string };
            attendees?: { email: string; displayName?: string; responseStatus?: string }[];
            location?: string;
            htmlLink?: string;
            organizer?: { email?: string; displayName?: string };
          };
          return {
            id: e.id,
            title: e.summary ?? "(No title)",
            description: e.description ?? "",
            start: e.start?.dateTime ?? e.start?.date ?? "",
            end: e.end?.dateTime ?? e.end?.date ?? "",
            attendees: (e.attendees ?? []).map(a => ({
              email: a.email,
              name: a.displayName ?? "",
              status: a.responseStatus ?? "",
            })),
            location: e.location ?? "",
            link: e.htmlLink ?? "",
            organizer: e.organizer ? {
              email: e.organizer.email ?? "",
              name: e.organizer.displayName ?? "",
            } : null,
          };
        });
      },
    },
  ];
}

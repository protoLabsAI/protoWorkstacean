/**
 * Google Calendar service — polling upcoming events and publishing to the bus.
 */

import type { EventBus } from "../../types.ts";
import { withCircuitBreaker } from "../circuit-breaker.ts";
import { getGoogleAccessToken } from "./auth.ts";

export interface CalendarConfig {
  orgCalendarId: string;
  pollIntervalMinutes: number;
}

export interface CalendarService {
  start(bus: EventBus): void;
  stop(): void;
}

export function createCalendarService(getConfig: () => CalendarConfig): CalendarService {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let initTimeout: ReturnType<typeof setTimeout> | null = null;

  async function _pollCalendar(bus: EventBus): Promise<void> {
    const config = getConfig();
    const calendarId = config.orgCalendarId;
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

  return {
    start(bus: EventBus) {
      const config = getConfig();
      const calendarId = config.orgCalendarId;
      if (!calendarId) {
        console.log("[google] Calendar polling skipped — no orgCalendarId configured");
        return;
      }

      const intervalMs = (config.pollIntervalMinutes ?? 60) * 60_000;
      initTimeout = setTimeout(() => _pollCalendar(bus), 15_000);
      pollTimer = setInterval(() => _pollCalendar(bus), intervalMs);
      console.log(`[google] Calendar poller started (interval: ${config.pollIntervalMinutes}m)`);
    },

    stop() {
      if (initTimeout) { clearTimeout(initTimeout); initTimeout = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    },
  };
}

/**
 * GooglePlugin — plugin shell that wires together Google Workspace service modules.
 *
 * Service modules:
 *   google/auth.ts     — OAuth2 token management + background refresh
 *   google/drive.ts    — Drive outbound handler + createDriveFolder utility
 *   google/docs.ts     — Docs outbound handler
 *   google/gmail.ts    — Gmail polling → message.inbound.google.gmail
 *   google/calendar.ts — Calendar polling → message.inbound.google.calendar
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
import type { EventBus, Plugin } from "../types.ts";
import { createTokenRefresher } from "./google/auth.ts";
import { createDriveService } from "./google/drive.ts";
import { createDocsService } from "./google/docs.ts";
import { createGmailService, createGmailOutbound, type GmailConfig } from "./google/gmail.ts";
import { createCalendarService, type CalendarConfig } from "./google/calendar.ts";

// Re-export utilities used by OnboardingPlugin
export { getGoogleAccessToken } from "./google/auth.ts";
export { createDriveFolder } from "./google/drive.ts";

// ── Config types ──────────────────────────────────────────────────────────────

interface GoogleConfig {
  drive: { orgFolderId: string; templateFolderId: string };
  calendar: CalendarConfig;
  gmail: GmailConfig;
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

// ── Plugin shell ──────────────────────────────────────────────────────────────

export class GooglePlugin implements Plugin {
  readonly name = "google";
  readonly description = "Google Workspace integration — Gmail, Drive, Calendar, Docs";
  readonly capabilities = ["google-gmail", "google-drive", "google-calendar", "google-docs"];

  private config!: GoogleConfig;
  private readonly workspaceDir: string;

  private readonly drive = createDriveService();
  private readonly docs = createDocsService();
  private gmail = createGmailService(() => this.config.gmail);
  private readonly gmailOutbound = createGmailOutbound();
  private calendar = createCalendarService(() => this.config.calendar);
  private tokenRefresher!: ReturnType<typeof createTokenRefresher>;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  install(bus: EventBus): void {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
      console.log("[google] GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN not set — plugin disabled");
      return;
    }

    this.config = loadConfig(this.workspaceDir);
    this.tokenRefresher = createTokenRefresher(bus);

    this.drive.start(bus);
    this.docs.start(bus);
    this.gmail.start(bus);
    this.gmailOutbound.start(bus);
    this.calendar.start(bus);
    this.tokenRefresher.start();

    // Hot-reload google.yaml
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
        this.gmail.stop();
        this.gmail = createGmailService(() => this.config.gmail);
        this.gmail.start(bus);
      }

      // Restart Calendar poller if interval changed
      if (prevCalInterval !== this.config.calendar?.pollIntervalMinutes) {
        this.calendar.stop();
        this.calendar = createCalendarService(() => this.config.calendar);
        this.calendar.start(bus);
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
    this.drive.stop();
    this.docs.stop();
    this.gmail.stop();
    this.gmailOutbound.stop();
    this.calendar.stop();
    this.tokenRefresher?.stop();
    unwatchFile(join(this.workspaceDir, "google.yaml"));
    console.log("[google] Plugin uninstalled");
  }
}

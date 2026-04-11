import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { CronExpressionParser } from "cron-parser";
import * as YAML from "yaml";
import type { Plugin, EventBus, BusMessage } from "../types";
import { CONFIG } from "../../src/config/env.ts";

const DEBUG = CONFIG.DEBUG === "1" || CONFIG.DEBUG === "true";

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

interface ScheduleDefinition {
  id: string;
  type?: "cron" | "once";
  schedule: string;
  timezone?: string;
  topic: string;
  payload: {
    content: string;
    sender?: string;
    channel?: string;
    recipient?: string;
    [key: string]: unknown;
  };
  enabled?: boolean;
  lastFired?: string | null;
}

function inferScheduleType(schedule: string): "cron" | "once" {
  // ISO datetime (2026-04-01T15:00:00) = one-shot
  // Everything else = cron expression
  return /^\d{4}-\d{2}-\d{2}T/.test(schedule) ? "once" : "cron";
}

interface ActiveTimer {
  definition: ScheduleDefinition;
  timer: ReturnType<typeof setTimeout>;
  filePath: string;
}

export class SchedulerPlugin implements Plugin {
  name = "scheduler";
  description = "Cron-style scheduled bus events with YAML persistence";
  capabilities: string[] = ["schedule", "timer", "cron"];

  private bus: EventBus | null = null;
  private cronsDir = "";
  private timers = new Map<string, ActiveTimer>();
  private defaultTimezone: string;
  private watchInterval: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string) {
    this.cronsDir = join(resolve(dataDir), "crons");
    this.defaultTimezone = CONFIG.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  install(bus: EventBus): void {
    this.bus = bus;

    if (!existsSync(this.cronsDir)) {
      mkdirSync(this.cronsDir, { recursive: true });
    }

    // Load existing schedules from YAML files
    this.loadAll();

    // Listen for runtime schedule commands
    bus.subscribe("command.schedule", this.name, (msg: BusMessage) => {
      this.handleCommand(msg);
    });

    debug("Scheduler ready. Timezone:", this.defaultTimezone, "Crons dir:", this.cronsDir);
  }

  uninstall(): void {
    if (this.watchInterval) clearInterval(this.watchInterval);
    for (const [, active] of this.timers) {
      clearTimeout(active.timer);
    }
    this.timers.clear();
  }

  // --- YAML I/O ---

  private loadAll(): void {
    const files = readdirSync(this.cronsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

    for (const file of files) {
      const filePath = join(this.cronsDir, file);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const def = YAML.parse(raw) as ScheduleDefinition;
        this.validate(def);
        this.schedule(def, filePath);
      } catch (err) {
        console.error(`[Scheduler] Failed to load ${file}:`, err);
      }
    }

    if (files.length > 0) {
      console.log(`[Scheduler] Loaded ${files.length} schedule(s) from ${this.cronsDir}`);
    }

    this.watchForNewFiles();
  }

  private watchForNewFiles(): void {
    const isCronFile = (f: string) => f.endsWith(".yaml") || f.endsWith(".yml");
    const existing = new Set(readdirSync(this.cronsDir).filter(isCronFile));

    this.watchInterval = setInterval(() => {
      let current: string[];
      try { current = readdirSync(this.cronsDir).filter(isCronFile); }
      catch { return; } // directory may not exist yet

      for (const file of current) {
        if (existing.has(file)) continue;
        const filePath = join(this.cronsDir, file);
        try {
          const def = YAML.parse(readFileSync(filePath, "utf-8")) as ScheduleDefinition;
          this.validate(def);
          this.schedule(def, filePath);
          existing.add(file);
          console.log(`[Scheduler] Hot-loaded new cron: ${file}`);
        } catch (err) {
          console.error(`[Scheduler] Failed to load ${file}:`, err);
        }
      }
    }, 5000);
  }

  private saveYaml(def: ScheduleDefinition, filePath: string): void {
    const doc = new YAML.Document(def);
    writeFileSync(filePath, doc.toString());
  }

  private validate(def: ScheduleDefinition): void {
    if (!def.id) throw new Error("missing id");
    if (!def.schedule) throw new Error("missing schedule");
    if (!def.topic) throw new Error("missing topic");
    if (!def.payload || !def.payload.content) throw new Error("payload.content is required");

    // Infer type from schedule format if not provided
    def.type = def.type || inferScheduleType(def.schedule);
    if (!["cron", "once"].includes(def.type)) throw new Error("type must be 'cron' or 'once'");

    if (def.type === "cron") {
      CronExpressionParser.parse(def.schedule);
    }
  }

  // --- Scheduling ---

  private schedule(def: ScheduleDefinition, filePath: string): void {
    // Clear existing timer for this id
    this.cancelTimer(def.id);

    if (def.enabled === false) {
      debug("Schedule disabled:", def.id);
      return;
    }

    const tz = def.timezone || this.defaultTimezone;
    const now = new Date();

    try {
      let nextDate: Date;

      if (def.type === "once") {
        const hasTimezone = /[+-]\d{2}:\d{2}|Z$/.test(def.schedule);
        if (!hasTimezone) {
          // No timezone suffix — interpret in the configured timezone
          const asUtc = new Date(def.schedule);
          const tzDate = new Date(asUtc.toLocaleString('en-US', { timeZone: tz }));
          const offset = tzDate.getTime() - asUtc.getTime();
          nextDate = new Date(asUtc.getTime() - offset);
        } else {
          nextDate = new Date(def.schedule);
        }
      } else {
        const interval = CronExpressionParser.parse(def.schedule, {
          currentDate: now,
          tz,
        });
        nextDate = interval.next().toDate();
      }

      const delay = nextDate.getTime() - now.getTime();

      // Fire immediately if missed (delay is negative and within reason — max 24h)
      if (delay < 0 && delay > -24 * 60 * 60 * 1000) {
        debug("Firing missed schedule:", def.id, "was", Math.round(-delay / 1000 / 60), "min ago");
        this.fire(def, filePath);
        if (def.type === "once") return; // one-shot, done
        // For recurring, schedule the next one after firing
      }

      // Cap setTimeout at max safe value (~24.8 days) — re-schedule if needed
      const maxDelay = 2_147_483_647; // max 32-bit signed int ms
      const actualDelay = Math.min(Math.max(delay, 0), maxDelay);

      const timer = setTimeout(() => {
        this.fire(def, filePath);
        if (def.type === "cron") {
          // Re-schedule next occurrence
          this.schedule(def, filePath);
        }
      }, actualDelay);

      this.timers.set(def.id, { definition: def, timer, filePath });

      const nextStr = nextDate.toISOString();
      debug("Scheduled:", def.id, "fires at", nextStr, `(${Math.round(actualDelay / 1000 / 60)} min)`);
    } catch (err) {
      console.error(`[Scheduler] Failed to schedule ${def.id}:`, err);
    }
  }

  private cancelTimer(id: string): void {
    const active = this.timers.get(id);
    if (active) {
      clearTimeout(active.timer);
      this.timers.delete(id);
    }
  }

  private fire(def: ScheduleDefinition, filePath: string): void {
    if (!this.bus) return;

    // Update lastFired
    def.lastFired = new Date().toISOString();

    if (def.type === "once") {
      // Delete the YAML file
      try {
        unlinkSync(filePath);
        debug("Deleted one-shot schedule:", def.id);
      } catch (err) {
        console.error(`[Scheduler] Failed to delete ${filePath}:`, err);
      }
      this.timers.delete(def.id);
    } else {
      // Update YAML with lastFired
      this.saveYaml(def, filePath);
    }

    // Publish to bus
    const msgId = crypto.randomUUID();
    const msg: BusMessage = {
      id: msgId,
      correlationId: msgId,
      topic: def.topic,
      timestamp: Date.now(),
      payload: { ...def.payload },
    };

    console.log(`[Scheduler] Firing: ${def.id} → ${def.topic}`);
    this.bus.publish(def.topic, msg);
  }

  // --- Bus Command Handler ---

  private handleCommand(msg: BusMessage): void {
    if (!this.bus) return;

    const payload = msg.payload as {
      action?: string;
      id?: string;
      type?: string;
      schedule?: string;
      timezone?: string;
      topic?: string;
      payload?: { content?: string; sender?: string; channel?: string; recipient?: string };
    };

    const action = payload.action;

    switch (action) {
      case "add":
        this.handleAdd(payload);
        break;
      case "remove":
        this.handleRemove(payload);
        break;
      case "list":
        this.handleList(msg);
        break;
      case "pause":
        this.handlePause(payload);
        break;
      case "resume":
        this.handleResume(payload);
        break;
      default:
        console.error(`[Scheduler] Unknown action: ${action}`);
    }
  }

  private handleAdd(payload: {
    id?: string;
    type?: string;
    schedule?: string;
    timezone?: string;
    topic?: string;
    payload?: { content?: string; sender?: string; channel?: string };
  }): void {
    if (!payload.id || !payload.schedule || !payload.topic || !payload.payload?.content) {
      console.error("[Scheduler] add requires: id, schedule, topic, payload.content");
      return;
    }

    const inferredType = inferScheduleType(payload.schedule);
    const def: ScheduleDefinition = {
      id: payload.id,
      type: payload.type ? (payload.type as "cron" | "once") : inferredType,
      schedule: payload.schedule,
      timezone: payload.timezone,
      topic: payload.topic,
      payload: payload.payload as ScheduleDefinition["payload"],
      enabled: true,
      lastFired: null,
    };

    try {
      this.validate(def);
    } catch (err) {
      console.error("[Scheduler] Invalid schedule:", err);
      return;
    }

    const filePath = join(this.cronsDir, `${def.id}.yaml`);
    this.saveYaml(def, filePath);
    this.schedule(def, filePath);

    console.log(`[Scheduler] Added: ${def.id} (${def.type} ${def.schedule})`);
  }

  private handleRemove(payload: { id?: string }): void {
    if (!payload.id) return;

    this.cancelTimer(payload.id);

    const filePath = join(this.cronsDir, `${payload.id}.yaml`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }

    console.log(`[Scheduler] Removed: ${payload.id}`);
  }

  private handleList(requestMsg: BusMessage): void {
    const list = Array.from(this.timers.values()).map((t) => ({
      id: t.definition.id,
      type: t.definition.type,
      schedule: t.definition.schedule,
      topic: t.definition.topic,
      enabled: t.definition.enabled !== false,
      lastFired: t.definition.lastFired,
    }));

    const reply: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: requestMsg.correlationId,
      topic: "schedule.list",
      timestamp: Date.now(),
      payload: { schedules: list },
    };

    this.bus!.publish(reply.topic, reply);
  }

  private handlePause(payload: { id?: string }): void {
    if (!payload.id) return;

    const active = this.timers.get(payload.id);
    if (active) {
      this.cancelTimer(payload.id);
      active.definition.enabled = false;
      this.saveYaml(active.definition, active.filePath);
      console.log(`[Scheduler] Paused: ${payload.id}`);
    }
  }

  private handleResume(payload: { id?: string }): void {
    if (!payload.id) return;

    const filePath = join(this.cronsDir, `${payload.id}.yaml`);
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      const def = YAML.parse(raw) as ScheduleDefinition;
      def.enabled = true;
      this.saveYaml(def, filePath);
      this.schedule(def, filePath);
      console.log(`[Scheduler] Resumed: ${payload.id}`);
    }
  }
}

/**
 * TODO(refactor): This file is 514 lines mixing YAML loading + hot-reload +
 * cron scheduling + skill dispatch + DB persistence. When next touching,
 * consider splitting:
 *   src/plugins/ceremony/loader.ts — YAML loading + hot-reload watcher
 *   src/plugins/ceremony/scheduler.ts — cron scheduling + timer management
 *   src/plugins/ceremony/dispatcher.ts — skill dispatch + outcome handling
 *   src/plugins/ceremony/outcomes-db.ts — SQLite persistence
 *   src/plugins/CeremonyPlugin.ts — plugin shell
 *
 * CeremonyPlugin — fleet-wide ceremony scheduling and execution.
 *
 * Replaces hardcoded cron tasks with configurable, observable, and
 * hot-reloadable YAML-defined ceremonies.
 *
 * Responsibilities:
 *   1. Load ceremony YAML files from workspace/ceremonies/ and
 *      .proto/projects/{slug}/ceremonies/
 *   2. Schedule cron timers for enabled ceremonies
 *   3. Hot-reload new/updated ceremony files (5-second poll)
 *   4. Publish ceremony.{id}.execute events when cron fires
 *   5. Dispatch skill invocations via EventBus
 *   6. Publish ceremony.{id}.completed events after execution
 *   7. Persist outcomes to knowledge.db
 *   8. Update WorldState.extensions.ceremonies
 *   9. Send Discord notifications (non-blocking)
 *  10. Deploy default ceremony YAML files on first run
 *
 * Topics published:
 *   ceremony.{id}.execute                    — ceremony cron fired
 *   ceremony.{id}.completed                  — ceremony run finished (kept for back-compat;
 *                                              subscribe to autonomous.outcome.ceremony.{id}.{skill}
 *                                              as the canonical unified outcome topic instead)
 *   autonomous.outcome.ceremony.{id}.{skill} — canonical unified outcome; emitted automatically by
 *                                              SkillDispatcherPlugin for every terminal task
 *   ceremony.state.snapshot                  — (via CeremonyStateExtension) ceremony state update
 *
 * Topics subscribed:
 *   ceremony.#               — intercepts completed events for persistence/notification
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { CronExpressionParser } from "cron-parser";
import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { Ceremony, CeremonyOutcome, CeremonyRunContext } from "./CeremonyPlugin.types.ts";
import type { CeremonyExecutePayload, CeremonyCompletedPayload } from "../events/ceremonyEvents.ts";
import { CeremonyYamlLoader } from "../loaders/ceremonyYamlLoader.ts";
import { CeremonyOutcomesRepository } from "../knowledge/ceremonyOutcomes.ts";
import { CeremonyStateExtension } from "../world/extensions/CeremonyStateExtension.ts";
import { CeremonyNotifier } from "../integrations/discord/CeremonyNotifier.ts";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
const HOT_RELOAD_INTERVAL_MS = 5_000;

function debug(...args: unknown[]): void {
  if (DEBUG) console.log("[DEBUG][ceremony]", ...args);
}

/** File metadata used to detect changes during hot-reload polling. */
interface FileSnapshot {
  mtime: number;
  size: number;
}

export class CeremonyPlugin implements Plugin {
  readonly name = "ceremony";
  readonly description = "YAML-defined fleet ceremony scheduler with hot-reload and EventBus integration";
  readonly capabilities = ["ceremony", "schedule", "skill-dispatch"];

  private bus: EventBus | null = null;
  private subscriptionIds: string[] = [];

  // Ceremony registry
  private ceremonies = new Map<string, Ceremony>();

  // Active cron timers per ceremony id
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  // Hot-reload watcher
  private watchInterval: ReturnType<typeof setInterval> | null = null;
  private fileSnapshots = new Map<string, FileSnapshot>();

  private readonly workspaceDir: string;
  private readonly projectsBaseDir: string;
  private readonly defaultsDir: string;

  private loader: CeremonyYamlLoader;
  private outcomes: CeremonyOutcomesRepository;
  private stateExtension: CeremonyStateExtension;
  private notifier: CeremonyNotifier;

  constructor(options?: {
    workspaceDir?: string;
    projectsBaseDir?: string;
    dbPath?: string;
  }) {
    this.workspaceDir = resolve(options?.workspaceDir ?? "workspace");
    this.projectsBaseDir = options?.projectsBaseDir
      ? resolve(options.projectsBaseDir)
      : join(dirname(this.workspaceDir), ".proto", "projects");
    this.defaultsDir = join(dirname(new URL(import.meta.url).pathname), "ceremonies", "defaults");

    this.loader = new CeremonyYamlLoader(this.workspaceDir, this.projectsBaseDir);
    this.outcomes = new CeremonyOutcomesRepository(options?.dbPath);
    this.stateExtension = new CeremonyStateExtension();
    this.notifier = new CeremonyNotifier();
  }

  install(bus: EventBus): void {
    this.bus = bus;

    // Initialize DB
    this.outcomes.init();

    // Install state extension (listens for completed events)
    this.stateExtension.install(bus);

    // Subscribe to ceremony.# to handle completed events for persistence/notification,
    // and to handle external execute triggers from the world engine / ActionDispatcher.
    const subId = bus.subscribe("ceremony.#", this.name, (msg: BusMessage) => {
      if (msg.topic.endsWith(".completed")) {
        this._onCeremonyCompleted(msg).catch((err) => {
          console.error("[ceremony] Error handling completed event:", err);
        });
      } else if (msg.topic.endsWith(".execute")) {
        // External trigger (e.g. from ActionDispatcher via world engine).
        // Internal cron fires set payload.type = "ceremony.execute" — skip those
        // to avoid double-firing.
        const payload = msg.payload as Record<string, unknown> | null;
        if (payload?.type === "ceremony.execute") return;

        // Extract ceremony ID from topic: ceremony.{id}.execute
        const parts = msg.topic.split(".");
        if (parts.length >= 3) {
          const ceremonyId = parts.slice(1, -1).join(".");
          const ceremony = this.ceremonies.get(ceremonyId);
          if (ceremony) {
            console.log(`[ceremony] External trigger received for: ${ceremonyId}`);
            this._fireCeremony(ceremony);
          } else {
            console.warn(`[ceremony] External trigger for unknown ceremony: ${ceremonyId}`);
          }
        }
      }
    });
    this.subscriptionIds.push(subId);

    // Deploy defaults on first run
    this._deployDefaults();

    // Load all ceremonies
    this._loadAndScheduleAll();

    // Start hot-reload watcher
    this._startHotReload();

    console.log(`[ceremony] Plugin installed — loaded ${this.ceremonies.size} ceremony(ies)`);
  }

  uninstall(): void {
    // Cancel all cron timers
    for (const [, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();

    // Stop hot-reload watcher
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }

    // Uninstall state extension
    this.stateExtension.uninstall();

    // Unsubscribe from bus
    if (this.bus) {
      for (const id of this.subscriptionIds) {
        this.bus.unsubscribe(id);
      }
    }
    this.subscriptionIds = [];
    this.bus = null;

    // Close DB
    this.outcomes.close();
  }

  /** Register a ceremony programmatically (in addition to YAML loading). */
  registerCeremony(ceremony: Ceremony): void {
    this.ceremonies.set(ceremony.id, ceremony);
    this.stateExtension.registerCeremony(ceremony);
    this._scheduleCeremony(ceremony);
    debug("Registered ceremony:", ceremony.id);
  }

  /** Unregister a ceremony. */
  unregisterCeremony(ceremonyId: string): void {
    this._cancelTimer(ceremonyId);
    this.ceremonies.delete(ceremonyId);
    this.stateExtension.unregisterCeremony(ceremonyId);
    debug("Unregistered ceremony:", ceremonyId);
  }

  /** Get all registered ceremonies. */
  getCeremonies(): Ceremony[] {
    return Array.from(this.ceremonies.values());
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _deployDefaults(): void {
    const ceremoniesDir = join(this.workspaceDir, "ceremonies");

    if (!existsSync(ceremoniesDir)) {
      mkdirSync(ceremoniesDir, { recursive: true });
    }

    if (!existsSync(this.defaultsDir)) {
      debug("Defaults directory not found:", this.defaultsDir);
      return;
    }

    let files: string[];
    try {
      files = readdirSync(this.defaultsDir).filter(
        (f) => f.endsWith(".yaml") || f.endsWith(".yml")
      );
    } catch {
      return;
    }

    let deployed = 0;
    for (const file of files) {
      const dest = join(ceremoniesDir, file);
      if (!existsSync(dest)) {
        try {
          copyFileSync(join(this.defaultsDir, file), dest);
          deployed++;
          debug("Deployed default ceremony:", file);
        } catch (err) {
          console.warn(`[ceremony] Failed to deploy default ${file}:`, err);
        }
      }
    }

    if (deployed > 0) {
      console.log(`[ceremony] Deployed ${deployed} default ceremony file(s) to ${ceremoniesDir}`);
    }
  }

  private _loadAndScheduleAll(): void {
    const loaded = this.loader.loadMerged();

    for (const ceremony of loaded.ceremonies) {
      this.ceremonies.set(ceremony.id, ceremony);
      this.stateExtension.registerCeremony(ceremony);
      this._scheduleCeremony(ceremony);
    }
  }

  private _scheduleCeremony(ceremony: Ceremony): void {
    this._cancelTimer(ceremony.id);

    if (!ceremony.enabled) {
      debug("Ceremony disabled:", ceremony.id);
      return;
    }

    try {
      const interval = CronExpressionParser.parse(ceremony.schedule);
      const nextDate = interval.next().toDate();
      const delay = nextDate.getTime() - Date.now();
      const actualDelay = Math.min(Math.max(delay, 0), 2_147_483_647);

      const timer = setTimeout(() => {
        this._fireCeremony(ceremony);
        // Reschedule
        const current = this.ceremonies.get(ceremony.id);
        if (current) this._scheduleCeremony(current);
      }, actualDelay);

      this.timers.set(ceremony.id, timer);
      debug(`Scheduled: ${ceremony.id} fires at ${nextDate.toISOString()} (delay: ${Math.round(actualDelay / 1000)}s)`);
    } catch (err) {
      console.error(`[ceremony] Failed to schedule ${ceremony.id}:`, err);
    }
  }

  private _cancelTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private _fireCeremony(ceremony: Ceremony): void {
    if (!this.bus) return;

    const runId = crypto.randomUUID();
    const context: CeremonyRunContext = {
      runId,
      ceremonyId: ceremony.id,
      projectPaths: ceremony.targets,
      startedAt: Date.now(),
    };

    // Mark as running in state extension
    this.stateExtension.markRunning(ceremony.id);

    // Publish execute event
    const executeTopic = `ceremony.${ceremony.id}.execute`;
    const executePayload: CeremonyExecutePayload = {
      type: "ceremony.execute",
      context,
      skill: ceremony.skill,
      ceremonyName: ceremony.name,
    };

    const executeMsg: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: runId,
      topic: executeTopic,
      timestamp: Date.now(),
      payload: executePayload,
    };

    console.log(`[ceremony] Firing: ${ceremony.id} (run ${runId})`);
    this.bus.publish(executeTopic, executeMsg);

    // Dispatch skill and publish completed
    this._dispatchSkillAndComplete(ceremony, context).catch((err) => {
      console.error(`[ceremony] Dispatch error for ${ceremony.id}:`, err);
    });
  }

  private async _dispatchSkillAndComplete(
    ceremony: Ceremony,
    context: CeremonyRunContext,
  ): Promise<void> {
    if (!this.bus) return;

    const startedAt = context.startedAt;
    let status: CeremonyOutcome["status"] = "success";
    let result: string | undefined;
    let error: string | undefined;

    try {
      // Dispatch skill invocation via EventBus
      // Agents (e.g. ava) subscribe to agent.skill.request and handle execution
      const skillRequestTopic = "agent.skill.request";
      const replyTopic = `agent.skill.response.${context.runId}`;

      const skillResult = await new Promise<string | null>((resolve) => {
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

        const subId = this.bus!.subscribe(replyTopic, this.name, (msg: BusMessage) => {
          if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
          this.bus?.unsubscribe(subId);
          const payload = msg.payload as { result?: string; error?: string };
          if (payload?.error) {
            error = payload.error;
            status = "failure";
          } else {
            result = payload?.result;
          }
          resolve(payload?.result ?? null);
        });

        // Set up per-ceremony timeout only if configured
        if (ceremony.timeoutMs !== undefined) {
          timeoutTimer = setTimeout(() => {
            this.bus?.unsubscribe(subId);
            resolve(null);
          }, ceremony.timeoutMs);
        }

        // Publish skill request
        this.bus!.publish(skillRequestTopic, {
          id: crypto.randomUUID(),
          correlationId: context.runId,
          topic: skillRequestTopic,
          timestamp: Date.now(),
          source: { interface: "cron" },
          payload: {
            skill: ceremony.skill,
            ceremonyId: ceremony.id,
            ceremonyName: ceremony.name,
            targets: ceremony.targets,
            runId: context.runId,
            projectPaths: context.projectPaths,
            meta: { systemActor: `ceremony.${ceremony.id}` },
          },
          reply: { topic: replyTopic },
        });
      });

      if (skillResult === null && !error && ceremony.timeoutMs !== undefined) {
        // Per-ceremony timeout fired
        status = "timeout";
        error = `Skill dispatch timed out after ${ceremony.timeoutMs / 1000}s`;
        console.warn(`[ceremony] Skill dispatch timeout for ${ceremony.id} (run ${context.runId})`);
      }
    } catch (err) {
      status = "failure";
      error = err instanceof Error ? err.message : String(err);
    }

    const completedAt = Date.now();
    const outcome: CeremonyOutcome = {
      runId: context.runId,
      ceremonyId: ceremony.id,
      skill: ceremony.skill,
      status,
      duration: completedAt - startedAt,
      targets: ceremony.targets,
      startedAt,
      completedAt,
      result,
      error,
    };

    // Publish completed event.
    // NOTE: SkillDispatcherPlugin already emits autonomous.outcome.ceremony.{id}.{skill}
    // for every terminal task — that is the canonical unified outcome topic. This publish
    // is retained for back-compat with any subscribers listening on ceremony.{id}.completed.
    const completedTopic = `ceremony.${ceremony.id}.completed`;
    const completedPayload: CeremonyCompletedPayload = {
      type: "ceremony.completed",
      outcome,
    };

    this.bus?.publish(completedTopic, {
      id: crypto.randomUUID(),
      correlationId: context.runId,
      topic: completedTopic,
      timestamp: Date.now(),
      payload: completedPayload,
    });

    debug(`Completed: ${ceremony.id} (run ${context.runId}) status=${status}`);
  }

  private async _onCeremonyCompleted(msg: BusMessage): Promise<void> {
    const payload = msg.payload as CeremonyCompletedPayload;
    if (payload?.type !== "ceremony.completed" || !payload.outcome) return;

    const outcome = payload.outcome;
    const ceremony = this.ceremonies.get(outcome.ceremonyId);

    // Persist outcome
    this.outcomes.save(outcome);

    // Send Discord notification (non-blocking)
    if (ceremony) {
      this.notifier
        .notify(outcome, ceremony.name, ceremony.notifyChannel)
        .catch((err) => {
          console.error("[ceremony] Discord notification error:", err);
        });
    }

    console.log(
      `[ceremony] ${outcome.status.toUpperCase()}: ${outcome.ceremonyId} ` +
      `(run ${outcome.runId}, ${outcome.duration}ms)`,
    );
  }

  // ── Hot-reload ────────────────────────────────────────────────────────────

  private _startHotReload(): void {
    const ceremoniesDir = join(this.workspaceDir, "ceremonies");

    this.watchInterval = setInterval(() => {
      this._checkForChanges(ceremoniesDir);
    }, HOT_RELOAD_INTERVAL_MS);
  }

  private _checkForChanges(dir: string): void {
    if (!existsSync(dir)) return;

    let files: string[];
    try {
      files = readdirSync(dir).filter(
        (f) => f.endsWith(".yaml") || f.endsWith(".yml")
      );
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const stat = Bun.file(filePath).size;
        const existing = this.fileSnapshots.get(filePath);

        // New or changed file
        if (!existing || existing.size !== stat) {
          this.fileSnapshots.set(filePath, { mtime: Date.now(), size: stat });

          if (!existing) {
            // New file — load and schedule
            const ceremonies = this.loader.loadGlobal();
            for (const ceremony of ceremonies) {
              if (!this.ceremonies.has(ceremony.id)) {
                this.registerCeremony(ceremony);
                console.log(`[ceremony] Hot-loaded new ceremony: ${ceremony.id}`);
              }
            }
          } else {
            // Changed file — reload all and reschedule changed ceremonies
            this._reloadChangedCeremonies();
          }
        }
      } catch {
        // File may be transient; ignore
      }
    }
  }

  private _reloadChangedCeremonies(): void {
    const loaded = this.loader.loadMerged();
    for (const ceremony of loaded.ceremonies) {
      const existing = this.ceremonies.get(ceremony.id);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(ceremony)) {
        this.ceremonies.set(ceremony.id, ceremony);
        this.stateExtension.registerCeremony(ceremony);
        this._scheduleCeremony(ceremony);
        console.log(`[ceremony] Hot-reloaded ceremony: ${ceremony.id}`);
      }
    }
  }
}

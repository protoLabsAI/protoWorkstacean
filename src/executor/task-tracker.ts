/**
 * TaskTracker — tracks long-running A2A tasks that returned non-terminal state.
 *
 * When an A2AExecutor gets a task back in "working" or "submitted" state
 * (i.e., the agent is still processing and hasn't returned a final result),
 * the dispatcher hands it to the tracker. The tracker polls each task
 * periodically and, when the state becomes terminal, publishes the final
 * response to the original reply topic.
 *
 * This closes the "5 min timeout → dropped result" gap without changing
 * the bus-facing dispatch contract: callers still receive exactly one
 * response on the reply topic, just later.
 */

import type { EventBus } from "../../lib/types.ts";
import type { A2AExecutor } from "./executors/a2a-executor.ts";
import type { AgentSkillResponsePayload } from "../event-bus/payloads.ts";
import type { TaskTrackerStore, PersistedTask } from "./task-tracker-store.ts";
import { Part } from "@a2a-js/sdk";
import { partText, parseWorldStateDelta } from "@protolabs/a2a";
import { logger } from "../../lib/log.ts";

const log = logger("task-tracker");

const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);

/**
 * Normalize parts that may arrive raw (proto3-JSON wire, from a push-notification
 * callback body) OR already SDK-deserialized (`content.$case`, from the poll
 * path) into a uniform SDK Part[] so the `@protolabs/a2a` helpers work on both.
 * Defensive: a malformed part is dropped, never thrown. (#765)
 */
function normalizeParts(raw: unknown): Part[] {
  if (!Array.isArray(raw)) return [];
  const out: Part[] = [];
  for (const p of raw) {
    try {
      out.push((p as { content?: unknown })?.content ? (p as Part) : Part.fromJSON(p));
    } catch { /* skip malformed */ }
  }
  return out;
}

const textOf = (parts: Part[]): string => parts.map(partText).filter((t): t is string => !!t).join("");

export interface TrackedTask {
  correlationId: string;
  taskId: string;
  agentName: string;
  /** Skill name the sub-agent is running. */
  skillName?: string;
  /** Name of the agent that dispatched this task (if any). */
  dispatcherAgent?: string;
  replyTopic: string;
  executor: A2AExecutor;
  parentId?: string;
  registeredAt: number;
  lastPolledAt: number;
  pollIntervalMs: number;
  /** Per-task secret for authenticating push-notification callbacks. */
  callbackToken?: string;
  /** Source interface (e.g. discord/linear) the request originated from. */
  sourceInterface?: string;
  sourceChannelId?: string;
  sourceUserId?: string;
  /**
   * Optional callback invoked when the task reaches terminal state.
   * Called before publishing the reply-topic response so the outcome
   * event is always emitted first.
   */
  onTerminal?: (content: string | undefined, isError: boolean, taskState: string) => void;
}

export interface TaskTrackerOptions {
  /** Event bus — tracker publishes responses here on terminal state. */
  bus: EventBus;
  /** How often to sweep the task map (ms). Default: 10s. */
  sweepIntervalMs?: number;
  /** Default per-task poll interval (ms). Default: 30s. */
  defaultPollIntervalMs?: number;
  /** Max time to track a task before giving up (ms). Default: 1hr. */
  maxTrackingMs?: number;
  /** Durable backing — when set, tasks survive restarts (rehydrated on boot). */
  store?: TaskTrackerStore;
  /** Resolve the live A2A executor for an agent (used to rehydrate after restart). */
  resolveExecutor?: (agentName: string, skill?: string) => A2AExecutor | undefined;
  /** Grace period after boot before an unresolvable rehydrated task is escalated (ms). Default: 5min. */
  rehydrateGraceMs?: number;
}

export class TaskTracker {
  private readonly tasks = new Map<string, TrackedTask>();
  private readonly bus: EventBus;
  private readonly sweepIntervalMs: number;
  private readonly defaultPollIntervalMs: number;
  private readonly maxTrackingMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  /** Tracks task IDs for which world.state.delta events have already been published. */
  private readonly publishedDeltaTaskIds = new Set<string>();

  /** Durable store (optional). */
  private readonly store?: TaskTrackerStore;
  private readonly resolveExecutor?: (agentName: string, skill?: string) => A2AExecutor | undefined;
  private readonly rehydrateGraceMs: number;
  private readonly bootAt = Date.now();
  /** Persisted tasks awaiting executor re-registration after a restart. */
  private readonly pending = new Map<string, PersistedTask>();

  constructor(opts: TaskTrackerOptions) {
    this.bus = opts.bus;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 10_000;
    this.defaultPollIntervalMs = opts.defaultPollIntervalMs ?? 30_000;
    this.maxTrackingMs = opts.maxTrackingMs ?? 60 * 60_000;
    this.store = opts.store;
    this.resolveExecutor = opts.resolveExecutor;
    this.rehydrateGraceMs = opts.rehydrateGraceMs ?? 5 * 60_000;
    // Rehydrate in-flight tasks owed a reply. They can't poll until the agent's
    // executor re-registers (A2A card discovery), so park them in `pending`;
    // _sweep promotes them once resolvable, or escalates after the grace window.
    for (const row of this.store?.loadAll() ?? []) {
      this.pending.set(row.correlationId, row);
    }
    if (this.pending.size > 0) {
      log.info(`rehydrated ${this.pending.size} in-flight task(s) from store — awaiting executor re-registration`);
    }
    this.sweepTimer = setInterval(() => { void this._sweep(); }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Remove a task from memory + pending + durable store. */
  private _forget(correlationId: string): void {
    this.tasks.delete(correlationId);
    this.pending.delete(correlationId);
    this.store?.delete(correlationId);
  }

  /**
   * Try to bring a persisted (rehydrated) task back to active polling by
   * resolving its agent's executor. Returns the live task, or null if the
   * executor isn't registered yet. `onTerminal` (the outcome-emit callback) is
   * not persisted, so a rehydrated task still publishes its reply but emits no
   * outcome telemetry — an acceptable loss vs. dropping the reply entirely.
   */
  private _rehydrate(row: PersistedTask): TrackedTask | null {
    const executor = this.resolveExecutor?.(row.agentName, row.skillName);
    if (!executor) return null;
    const task: TrackedTask = { ...row, executor, lastPolledAt: 0 };
    this.tasks.set(row.correlationId, task);
    this.pending.delete(row.correlationId);
    return task;
  }

  /** Promote rehydrated tasks once their executor re-registers; escalate the unresolvable. */
  private _promoteRehydrated(now: number): void {
    if (this.pending.size === 0) return;
    for (const [, row] of [...this.pending]) {
      if (this._rehydrate(row)) {
        log.info(`resumed ${row.agentName} task ${row.taskId.slice(0, 8)}… after restart`);
        continue;
      }
      // Executor still unregistered — escalate (don't silently drop) once the
      // task ages out or the post-boot grace window elapses.
      if (now - row.registeredAt > this.maxTrackingMs || now - this.bootAt >= this.rehydrateGraceMs) {
        this._escalateInterrupted(row);
      }
    }
  }

  /** Publish a failure to the reply topic for a task that couldn't be resumed. */
  private _escalateInterrupted(row: PersistedTask): void {
    log.warn(`could not resume ${row.agentName} task ${row.taskId.slice(0, 8)}… — escalating as interrupted`);
    const payload: AgentSkillResponsePayload = {
      error: "Task interrupted by a workstacean restart and could not be resumed — please retry.",
      correlationId: row.correlationId,
      taskState: "failed",
      taskId: row.taskId,
    };
    this.bus.publish(row.replyTopic, {
      id: crypto.randomUUID(),
      correlationId: row.correlationId,
      topic: row.replyTopic,
      timestamp: Date.now(),
      payload,
    });
    this._forget(row.correlationId);
  }

  /** Register a task for tracking. Dispatcher calls this after executor returns working. */
  track(params: {
    correlationId: string;
    taskId: string;
    agentName: string;
    /** Skill name — enables hitl-mode registry lookup for input-required routing. */
    skillName?: string;
    /** Dispatching agent — enables caller-first HITL chain (agent answers before human). */
    dispatcherAgent?: string;
    replyTopic: string;
    executor: A2AExecutor;
    parentId?: string;
    pollIntervalMs?: number;
    /** Per-task token for authenticating push callbacks. Generated if omitted. */
    callbackToken?: string;
    /** Source interface/channel/user — reused to route input-required HITL requests. */
    sourceInterface?: string;
    sourceChannelId?: string;
    sourceUserId?: string;
    /** Invoked when the task reaches terminal state — before the reply-topic response is published. */
    onTerminal?: (content: string | undefined, isError: boolean, taskState: string) => void;
  }): void {
    const now = Date.now();
    this.tasks.set(params.correlationId, {
      correlationId: params.correlationId,
      taskId: params.taskId,
      agentName: params.agentName,
      skillName: params.skillName,
      dispatcherAgent: params.dispatcherAgent,
      replyTopic: params.replyTopic,
      executor: params.executor,
      parentId: params.parentId,
      registeredAt: now,
      lastPolledAt: now,
      pollIntervalMs: params.pollIntervalMs ?? this.defaultPollIntervalMs,
      callbackToken: params.callbackToken ?? crypto.randomUUID(),
      sourceInterface: params.sourceInterface,
      sourceChannelId: params.sourceChannelId,
      sourceUserId: params.sourceUserId,
      onTerminal: params.onTerminal,
    });
    const t = this.tasks.get(params.correlationId)!;
    this.store?.upsert({
      correlationId: t.correlationId, taskId: t.taskId, agentName: t.agentName,
      skillName: t.skillName, dispatcherAgent: t.dispatcherAgent, replyTopic: t.replyTopic,
      parentId: t.parentId, registeredAt: t.registeredAt, pollIntervalMs: t.pollIntervalMs,
      callbackToken: t.callbackToken, sourceInterface: t.sourceInterface,
      sourceChannelId: t.sourceChannelId, sourceUserId: t.sourceUserId,
    });
    log.info(
      `Tracking ${params.agentName} task ${params.taskId.slice(0, 8)}… (correlationId: ${params.correlationId.slice(0, 8)}…)`,
    );
  }

  /** Look up the callback token for a tracked task. Used by the webhook route. */
  getCallbackToken(correlationId: string): string | undefined {
    return this.tasks.get(correlationId)?.callbackToken ?? this.pending.get(correlationId)?.callbackToken;
  }

  /**
   * Handle an incoming push notification. Body is the A2A Task object.
   * If the task is terminal, we publish the response and untrack. Otherwise
   * we update lastPolledAt so the polling loop gives the task more time.
   */
  handleCallback(correlationId: string, body: Record<string, unknown>): void {
    // Recover a task whose poll loop was lost to a restart: the callback token
    // is persisted, so an agent's push callback can re-find it in `pending`.
    let task = this.tasks.get(correlationId);
    if (!task) {
      const row = this.pending.get(correlationId);
      if (row) task = this._rehydrate(row) ?? undefined;
    }
    if (!task) return;

    const status = (body.status ?? {}) as { state?: string; message?: { parts?: unknown[] } };
    const state = typeof status.state === "string" ? status.state : undefined;

    task.lastPolledAt = Date.now();

    if (state === "input-required") {
      const statusText = textOf(normalizeParts(status.message?.parts));
      log.warn(
        `${task.agentName} task ${task.taskId.slice(0, 8)}… is input-required ` +
        `but no approval gate is wired — terminating with failure. Question: ${statusText || "(none)"}`,
      );
      this._publishResponse(task, undefined, `Agent asked for human input but no approval gate is wired: ${statusText || "(no question text)"}`, "failed");
      this._forget(correlationId);
      return;
    }

    if (!state || !TERMINAL_STATES.has(state)) {
      // Non-terminal update — just refresh the polled timestamp
      return;
    }

    // Extract text from artifacts (primary) or status.message (fallback).
    // The callback body is RAW wire proto3-JSON, so normalize parts to SDK
    // shape (content.$case) before reading them. (#765)
    const rawArtifacts = (body.artifacts ?? []) as Array<{ parts?: unknown }>;
    const artifacts = rawArtifacts.map(a => ({ parts: normalizeParts(a.parts) }));
    const artifactText = artifacts.flatMap(a => a.parts).map(partText).filter((t): t is string => !!t).join("\n");
    const statusText = textOf(normalizeParts(status.message?.parts));
    const content = artifactText || statusText;
    const isError = state === "failed" || state === "rejected";

    this._extractAndPublishDeltas(task.taskId, task.agentName, artifacts);
    this._publishResponse(task, isError ? undefined : content, isError ? (content || state) : undefined, state);
    this._forget(correlationId);
    log.info(
      `Callback for ${task.taskId.slice(0, 8)}… → terminal state "${state}" (via webhook)`,
    );
  }

  /** Stop tracking a task (e.g., on cancel). */
  untrack(correlationId: string): void {
    this._forget(correlationId);
  }

  /** Get snapshot of currently-tracked tasks — for API endpoint. */
  getAll(): TrackedTask[] {
    return Array.from(this.tasks.values());
  }

  get size(): number {
    return this.tasks.size;
  }

  destroy(): void {
    clearInterval(this.sweepTimer);
    this.tasks.clear();
  }

  /**
   * Sweep all tracked tasks. For each due (lastPolledAt + pollIntervalMs < now),
   * fetch its current state. On terminal: publish response, untrack. On stuck
   * past maxTrackingMs: publish timeout response, untrack.
   */
  private async _sweep(): Promise<void> {
    const now = Date.now();

    this._promoteRehydrated(now);

    for (const task of this.tasks.values()) {
      // Age-out: task has been working for too long
      if (now - task.registeredAt > this.maxTrackingMs) {
        this._publishResponse(task, undefined, `Task tracking timeout (>${Math.round(this.maxTrackingMs / 60_000)}min)`);
        this._forget(task.correlationId);
        continue;
      }

      // Not yet due
      if (now - task.lastPolledAt < task.pollIntervalMs) continue;

      task.lastPolledAt = now;

      try {
        const result = await task.executor.pollTask(task.taskId, task.correlationId, task.parentId);
        const state = result.data?.taskState;

        if (state === "input-required") {
          log.warn(
            `${task.agentName} task ${task.taskId.slice(0, 8)}… is input-required ` +
            `but no approval gate is wired — terminating with failure. Question: ${result.text || "(none)"}`,
          );
          this._publishResponse(task, undefined, `Agent asked for human input but no approval gate is wired: ${result.text || "(no question text)"}`, "failed");
          this._forget(task.correlationId);
          continue;
        }

        if (state && TERMINAL_STATES.has(state)) {
          // pollTask returns SDK-deserialized (content.$case) artifacts; normalize
          // is a no-op for those but keeps _extractAndPublishDeltas shape-uniform.
          const polledArtifacts = (result.data?.artifacts ?? []) as Array<{ parts?: unknown }>;
          const artifacts = polledArtifacts.map(a => ({ parts: normalizeParts(a.parts) }));
          this._extractAndPublishDeltas(task.taskId, task.agentName, artifacts);
          // Record cost-v1/confidence-v1 samples here: execute() returned
          // non-terminal (it handed off to us) so it skipped its after-hooks.
          // result.data carries the extension payloads pollTask extracted.
          await task.executor.recordTerminalExtensions(task.skillName ?? "unknown", task.correlationId, result.data);
          this._publishResponse(task, result.text, result.isError ? result.text : undefined, state, result.data);
          this._forget(task.correlationId);
          log.info(
            `Task ${task.taskId.slice(0, 8)}… reached terminal state "${state}" after ${Math.round((now - task.registeredAt) / 1000)}s`,
          );
        }
      } catch (err) {
        log.warn(
          `poll failed for ${task.taskId.slice(0, 8)}…`,
          { err: err instanceof Error ? err.message : String(err) },
        );
      }
    }
  }

  /**
   * Scan terminal task artifacts for a worldstate-delta-v1 DataPart and publish
   * a `world.state.delta` event per delta entry. Parts are SDK-shaped
   * (content.$case) — callers normalize raw-wire bodies first. Idempotent: a
   * given taskId is processed at most once even if both the callback and sweep
   * paths fire. (#765 — was reading the legacy 0.3 `kind`/`data` shape.)
   */
  private _extractAndPublishDeltas(
    taskId: string,
    agentName: string,
    artifacts: Array<{ parts?: Part[] }>,
  ): void {
    if (this.publishedDeltaTaskIds.has(taskId)) return;
    this.publishedDeltaTaskIds.add(taskId);

    for (const artifact of artifacts) {
      const delta = parseWorldStateDelta(artifact.parts ?? []);
      for (const entry of delta?.deltas ?? []) {
        const { domain, path, op, value } = entry;
        if (typeof domain !== "string" || typeof path !== "string" || typeof op !== "string") continue;

        const topic = "world.state.delta";
        this.bus.publish(topic, {
          id: crypto.randomUUID(),
          correlationId: taskId,
          topic,
          timestamp: Date.now(),
          payload: { domain, path, op, value, sourceTaskId: taskId, sourceAgent: agentName },
        });
        log.info(
          `world.state.delta: ${domain}.${path} op=${op} from ${agentName} (task ${taskId.slice(0, 8)}…)`,
        );
      }
    }
  }

  private _publishResponse(
    task: TrackedTask,
    content: string | undefined,
    error: string | undefined,
    taskState?: string,
    data?: Record<string, unknown>,
  ): void {
    const isError = error !== undefined;
    const resolvedState = taskState ?? (isError ? "failed" : "completed");
    task.onTerminal?.(content, isError, resolvedState);

    const payload: AgentSkillResponsePayload = {
      content,
      error,
      correlationId: task.correlationId,
      taskState: resolvedState,
      taskId: task.taskId,
      ...(typeof data?.contextId === "string" ? { contextId: data.contextId } : {}),
      ...(data?.usage ? { usage: data.usage as AgentSkillResponsePayload["usage"] } : {}),
      ...(typeof data?.costUsd === "number" ? { costUsd: data.costUsd } : {}),
      ...(typeof data?.confidence === "number" ? { confidence: data.confidence } : {}),
      ...(typeof data?.confidenceExplanation === "string"
        ? { confidenceExplanation: data.confidenceExplanation } : {}),
    };
    // Terminal result is cached downstream by SkillResponseCache, which
    // subscribes to agent.skill.response.# (covers both this A2A path and the
    // dispatcher's inline-complete path uniformly). We just publish.
    this.bus.publish(task.replyTopic, {
      id: crypto.randomUUID(),
      correlationId: task.correlationId,
      topic: task.replyTopic,
      timestamp: Date.now(),
      payload,
    });
  }
}

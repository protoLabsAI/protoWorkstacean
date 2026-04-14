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

const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);

export interface TrackedTask {
  correlationId: string;
  taskId: string;
  agentName: string;
  replyTopic: string;
  executor: A2AExecutor;
  parentId?: string;
  registeredAt: number;
  lastPolledAt: number;
  pollIntervalMs: number;
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
}

export class TaskTracker {
  private readonly tasks = new Map<string, TrackedTask>();
  private readonly bus: EventBus;
  private readonly sweepIntervalMs: number;
  private readonly defaultPollIntervalMs: number;
  private readonly maxTrackingMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(opts: TaskTrackerOptions) {
    this.bus = opts.bus;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 10_000;
    this.defaultPollIntervalMs = opts.defaultPollIntervalMs ?? 30_000;
    this.maxTrackingMs = opts.maxTrackingMs ?? 60 * 60_000;
    this.sweepTimer = setInterval(() => { void this._sweep(); }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Register a task for tracking. Dispatcher calls this after executor returns working. */
  track(params: {
    correlationId: string;
    taskId: string;
    agentName: string;
    replyTopic: string;
    executor: A2AExecutor;
    parentId?: string;
    pollIntervalMs?: number;
  }): void {
    const now = Date.now();
    this.tasks.set(params.correlationId, {
      correlationId: params.correlationId,
      taskId: params.taskId,
      agentName: params.agentName,
      replyTopic: params.replyTopic,
      executor: params.executor,
      parentId: params.parentId,
      registeredAt: now,
      lastPolledAt: now,
      pollIntervalMs: params.pollIntervalMs ?? this.defaultPollIntervalMs,
    });
    console.log(
      `[task-tracker] Tracking ${params.agentName} task ${params.taskId.slice(0, 8)}… (correlationId: ${params.correlationId.slice(0, 8)}…)`,
    );
  }

  /** Stop tracking a task (e.g., on cancel). */
  untrack(correlationId: string): void {
    this.tasks.delete(correlationId);
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

    for (const task of this.tasks.values()) {
      // Age-out: task has been working for too long
      if (now - task.registeredAt > this.maxTrackingMs) {
        this._publishResponse(task, undefined, `Task tracking timeout (>${Math.round(this.maxTrackingMs / 60_000)}min)`);
        this.tasks.delete(task.correlationId);
        continue;
      }

      // Not yet due
      if (now - task.lastPolledAt < task.pollIntervalMs) continue;

      task.lastPolledAt = now;

      try {
        const result = await task.executor.pollTask(task.taskId, task.correlationId, task.parentId);
        const state = result.data?.taskState;

        if (state && TERMINAL_STATES.has(state)) {
          this._publishResponse(task, result.text, result.isError ? result.text : undefined);
          this.tasks.delete(task.correlationId);
          console.log(
            `[task-tracker] Task ${task.taskId.slice(0, 8)}… reached terminal state "${state}" after ${Math.round((now - task.registeredAt) / 1000)}s`,
          );
        }
      } catch (err) {
        console.warn(
          `[task-tracker] poll failed for ${task.taskId.slice(0, 8)}…:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private _publishResponse(task: TrackedTask, content: string | undefined, error: string | undefined): void {
    const payload: AgentSkillResponsePayload = {
      content,
      error,
      correlationId: task.correlationId,
    };
    this.bus.publish(task.replyTopic, {
      id: crypto.randomUUID(),
      correlationId: task.correlationId,
      topic: task.replyTopic,
      timestamp: Date.now(),
      payload,
    });
  }
}

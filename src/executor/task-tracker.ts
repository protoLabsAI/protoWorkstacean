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

/** Extension URI for worldstate-delta-v1 artifacts. */
const WORLDSTATE_DELTA_URI = "https://proto-labs.ai/a2a/ext/worldstate-delta-v1";

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
  /** How long a terminal result stays retrievable via getResult (ms). Default: 5min. */
  resultTtlMs?: number;
}

export class TaskTracker {
  private readonly tasks = new Map<string, TrackedTask>();
  private readonly bus: EventBus;
  private readonly sweepIntervalMs: number;
  private readonly defaultPollIntervalMs: number;
  private readonly maxTrackingMs: number;
  private readonly resultTtlMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  /** Tracks task IDs for which world.state.delta events have already been published. */
  private readonly publishedDeltaTaskIds = new Set<string>();
  /** Terminal results retained briefly so a caller that stopped awaiting the
   *  reply topic (e.g. a chat request that hit its timeout) can still fetch the
   *  final outcome by correlationId. TTL-evicted in the sweep. */
  private readonly recentResults = new Map<string, { payload: AgentSkillResponsePayload; at: number }>();

  constructor(opts: TaskTrackerOptions) {
    this.bus = opts.bus;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 10_000;
    this.defaultPollIntervalMs = opts.defaultPollIntervalMs ?? 30_000;
    this.maxTrackingMs = opts.maxTrackingMs ?? 60 * 60_000;
    this.resultTtlMs = opts.resultTtlMs ?? 5 * 60_000;
    this.sweepTimer = setInterval(() => { void this._sweep(); }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
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
    console.log(
      `[task-tracker] Tracking ${params.agentName} task ${params.taskId.slice(0, 8)}… (correlationId: ${params.correlationId.slice(0, 8)}…)`,
    );
  }

  /** Look up the callback token for a tracked task. Used by the webhook route. */
  getCallbackToken(correlationId: string): string | undefined {
    return this.tasks.get(correlationId)?.callbackToken;
  }

  /**
   * Handle an incoming push notification. Body is the A2A Task object.
   * If the task is terminal, we publish the response and untrack. Otherwise
   * we update lastPolledAt so the polling loop gives the task more time.
   */
  handleCallback(correlationId: string, body: Record<string, unknown>): void {
    const task = this.tasks.get(correlationId);
    if (!task) return;

    const status = (body.status ?? {}) as { state?: string; message?: { parts?: Array<{ kind?: string; text?: string }> } };
    const state = typeof status.state === "string" ? status.state : undefined;

    task.lastPolledAt = Date.now();

    if (state === "input-required") {
      const statusText = status.message?.parts
        ? status.message.parts.filter(p => p.kind === "text").map(p => p.text ?? "").join("")
        : "";
      console.warn(
        `[task-tracker] ${task.agentName} task ${task.taskId.slice(0, 8)}… is input-required ` +
        `but no approval gate is wired — terminating with failure. Question: ${statusText || "(none)"}`,
      );
      this._publishResponse(task, undefined, `Agent asked for human input but no approval gate is wired: ${statusText || "(no question text)"}`, "failed");
      this.tasks.delete(correlationId);
      return;
    }

    if (!state || !TERMINAL_STATES.has(state)) {
      // Non-terminal update — just refresh the polled timestamp
      return;
    }

    // Extract text from artifacts (primary) or status.message (fallback)
    const artifacts = (body.artifacts ?? []) as Array<{ extensions?: string[]; parts?: Array<{ kind?: string; text?: string; data?: Record<string, unknown> }> }>;
    const artifactText = artifacts
      .flatMap(a => a.parts ?? [])
      .filter((p): p is { kind: "text"; text: string } => p.kind === "text" && typeof p.text === "string")
      .map(p => p.text)
      .join("\n");
    const statusText = status.message?.parts
      ? status.message.parts.filter(p => p.kind === "text").map(p => p.text ?? "").join("")
      : "";
    const content = artifactText || statusText;
    const isError = state === "failed" || state === "rejected";

    this._extractAndPublishDeltas(task.taskId, task.agentName, artifacts);
    this._publishResponse(task, isError ? undefined : content, isError ? (content || state) : undefined, state);
    this.tasks.delete(correlationId);
    console.log(
      `[task-tracker] Callback for ${task.taskId.slice(0, 8)}… → terminal state "${state}" (via webhook)`,
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
    this.recentResults.clear();
  }

  /**
   * Sweep all tracked tasks. For each due (lastPolledAt + pollIntervalMs < now),
   * fetch its current state. On terminal: publish response, untrack. On stuck
   * past maxTrackingMs: publish timeout response, untrack.
   */
  private async _sweep(): Promise<void> {
    const now = Date.now();

    // Evict aged-out terminal results.
    for (const [correlationId, entry] of this.recentResults) {
      if (now - entry.at > this.resultTtlMs) this.recentResults.delete(correlationId);
    }

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

        if (state === "input-required") {
          console.warn(
            `[task-tracker] ${task.agentName} task ${task.taskId.slice(0, 8)}… is input-required ` +
            `but no approval gate is wired — terminating with failure. Question: ${result.text || "(none)"}`,
          );
          this._publishResponse(task, undefined, `Agent asked for human input but no approval gate is wired: ${result.text || "(no question text)"}`, "failed");
          this.tasks.delete(task.correlationId);
          continue;
        }

        if (state && TERMINAL_STATES.has(state)) {
          const rawArtifacts = (result.data?.artifacts ?? []) as Array<{ extensions?: string[]; parts?: Array<{ kind?: string; text?: string; data?: Record<string, unknown> }> }>;
          this._extractAndPublishDeltas(task.taskId, task.agentName, rawArtifacts);
          this._publishResponse(task, result.text, result.isError ? result.text : undefined, state, result.data);
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

  /**
   * Scan terminal task artifacts for worldstate-delta-v1 data parts and publish
   * a `world.state.delta` event for each one. Idempotent: a given taskId is
   * processed at most once even if both the callback and sweep paths fire.
   */
  private _extractAndPublishDeltas(
    taskId: string,
    agentName: string,
    artifacts: Array<{
      extensions?: string[];
      parts?: Array<{ kind?: string; text?: string; data?: Record<string, unknown> }>;
    }>,
  ): void {
    if (this.publishedDeltaTaskIds.has(taskId)) return;
    this.publishedDeltaTaskIds.add(taskId);

    for (const artifact of artifacts) {
      if (!artifact.extensions?.includes(WORLDSTATE_DELTA_URI)) continue;
      for (const part of artifact.parts ?? []) {
        if (part.kind !== "data" || !part.data) continue;
        const { domain, path, op, value } = part.data;
        if (typeof domain !== "string" || typeof path !== "string" || typeof op !== "string") continue;

        const topic = "world.state.delta";
        this.bus.publish(topic, {
          id: crypto.randomUUID(),
          correlationId: taskId,
          topic,
          timestamp: Date.now(),
          payload: {
            domain,
            path,
            op,
            value,
            sourceTaskId: taskId,
            sourceAgent: agentName,
          },
        });
        console.log(
          `[task-tracker] world.state.delta: ${domain}.${path} op=${op} from ${agentName} (task ${taskId.slice(0, 8)}…)`,
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
    this.recentResults.set(task.correlationId, { payload, at: Date.now() });
    this.bus.publish(task.replyTopic, {
      id: crypto.randomUUID(),
      correlationId: task.correlationId,
      topic: task.replyTopic,
      timestamp: Date.now(),
      payload,
    });
  }

  /**
   * Fetch a recently-terminal task's result by correlationId. Returns undefined
   * if the task is still running, never existed, or its result has aged past
   * resultTtlMs. Backs GET /api/a2a/task/:correlationId so a chat caller that
   * timed out can still retrieve the final outcome.
   */
  getResult(correlationId: string): AgentSkillResponsePayload | undefined {
    const entry = this.recentResults.get(correlationId);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.resultTtlMs) {
      this.recentResults.delete(correlationId);
      return undefined;
    }
    return entry.payload;
  }
}

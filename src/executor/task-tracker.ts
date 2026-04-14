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

import type { EventBus, BusMessage, HITLRequest, HITLResponse } from "../../lib/types.ts";
import type { A2AExecutor } from "./executors/a2a-executor.ts";
import type { AgentSkillResponsePayload } from "../event-bus/payloads.ts";

const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);
const HITL_TTL_MS = 30 * 60_000; // 30 min default input-required window

/** Extension URI for worldstate-delta-v1 artifacts. */
const WORLDSTATE_DELTA_URI = "https://protolabs.ai/a2a/ext/worldstate-delta-v1";

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
  /** Per-task secret for authenticating push-notification callbacks. */
  callbackToken?: string;
  /** Set when the task has asked for human input — suppresses polling until resumed. */
  awaitingHuman?: boolean;
  /** The Discord/etc interface that originated the request — reused for HITL routing. */
  sourceInterface?: string;
  /** Source channel ID for HITL rendering. */
  sourceChannelId?: string;
  /** User ID for HITL rendering. */
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

  constructor(opts: TaskTrackerOptions) {
    this.bus = opts.bus;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 10_000;
    this.defaultPollIntervalMs = opts.defaultPollIntervalMs ?? 30_000;
    this.maxTrackingMs = opts.maxTrackingMs ?? 60 * 60_000;
    this.sweepTimer = setInterval(() => { void this._sweep(); }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();

    // Subscribe to HITL responses — when a tracked task was awaiting input
    // and a human responds, resume the task via sendMessage(taskId, decisionText).
    this.bus.subscribe("hitl.response.#", "task-tracker", (msg: BusMessage) => {
      const resp = msg.payload as HITLResponse | undefined;
      if (!resp || resp.type !== "hitl_response") return;
      void this._resumeFromHitl(resp);
    });
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
      this._raiseHitl(task, statusText);
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

      // Awaiting human input — don't poll, just wait for hitl.response.*
      if (task.awaitingHuman) continue;

      // Not yet due
      if (now - task.lastPolledAt < task.pollIntervalMs) continue;

      task.lastPolledAt = now;

      try {
        const result = await task.executor.pollTask(task.taskId, task.correlationId, task.parentId);
        const state = result.data?.taskState;

        if (state === "input-required") {
          this._raiseHitl(task, result.text);
          continue;
        }

        if (state && TERMINAL_STATES.has(state)) {
          const rawArtifacts = (result.data?.artifacts ?? []) as Array<{ extensions?: string[]; parts?: Array<{ kind?: string; text?: string; data?: Record<string, unknown> }> }>;
          this._extractAndPublishDeltas(task.taskId, task.agentName, rawArtifacts);
          this._publishResponse(task, result.text, result.isError ? result.text : undefined, state);
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
   * Emit a HITL request for a task that hit input-required. HITLPlugin will
   * route to the registered renderer (Discord approval buttons, etc). The
   * response flows back via hitl.response.# which we subscribe to.
   */
  private _raiseHitl(task: TrackedTask, question: string | undefined): void {
    if (task.awaitingHuman) return; // already raised, avoid duplicate
    task.awaitingHuman = true;

    const req: HITLRequest = {
      type: "hitl_request",
      correlationId: task.correlationId,
      title: `Input needed from ${task.agentName}`,
      summary: question || "The agent is requesting input to continue.",
      options: ["approve", "reject"],
      expiresAt: new Date(Date.now() + HITL_TTL_MS).toISOString(),
      replyTopic: `hitl.response.${task.correlationId}`,
      sourceMeta: {
        interface: task.sourceInterface ?? "discord",
        channelId: task.sourceChannelId,
        userId: task.sourceUserId,
      },
    };

    this.bus.publish(`hitl.request.${task.correlationId}`, {
      id: crypto.randomUUID(),
      correlationId: task.correlationId,
      topic: `hitl.request.${task.correlationId}`,
      timestamp: Date.now(),
      payload: req,
    });

    console.log(
      `[task-tracker] input-required from ${task.agentName} — raised HITL request (correlationId: ${task.correlationId.slice(0, 8)}…)`,
    );
  }

  /**
   * When a HITL response arrives for a tracked task, resume the agent by
   * sending a new message in the same taskId. Uses executor.execute() with
   * the original skill context so memory enrichment still applies.
   */
  private async _resumeFromHitl(resp: HITLResponse): Promise<void> {
    const task = this.tasks.get(resp.correlationId);
    if (!task || !task.awaitingHuman) return;

    const decisionText = [
      `Human decision: ${resp.decision}`,
      resp.feedback ? `Feedback: ${resp.feedback}` : "",
      `Decided by: ${resp.decidedBy}`,
    ].filter(Boolean).join("\n");

    try {
      await task.executor.resumeTask(
        task.taskId,
        task.correlationId,
        decisionText,
        task.correlationId,
        task.parentId,
      );
      task.awaitingHuman = false;
      task.lastPolledAt = Date.now();
      console.log(
        `[task-tracker] Resumed ${task.taskId.slice(0, 8)}… with decision "${resp.decision}" — polling resumes`,
      );
    } catch (err) {
      console.error(
        `[task-tracker] Failed to resume ${task.taskId.slice(0, 8)}…:`,
        err instanceof Error ? err.message : String(err),
      );
      this._publishResponse(task, undefined, `Resume failed: ${err instanceof Error ? err.message : String(err)}`);
      this.tasks.delete(task.correlationId);
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
  ): void {
    const isError = error !== undefined;
    const resolvedState = taskState ?? (isError ? "failed" : "completed");
    task.onTerminal?.(content, isError, resolvedState);

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

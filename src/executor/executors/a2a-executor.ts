/**
 * A2AExecutor — dispatches a skill to an external agent via @a2a-js/sdk.
 *
 * Uses the new ClientFactory / Client API (JSON-RPC transport). The SDK handles:
 *   - JSON-RPC request/response shape and error envelope unwrapping
 *   - SSE streaming (sendMessageStream) with automatic fallback to sendMessage
 *     when the agent card says capabilities.streaming !== true
 *   - Agent card resolution (DefaultAgentCardResolver)
 *   - Auth-handler pattern (wired per-instance via createAuthenticatingFetchWithRetry)
 *
 * Registered by SkillBrokerPlugin during install().
 */

import { ClientFactory, JsonRpcTransportFactory, type Client } from "@a2a-js/sdk/client";
import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";
import {
  WORLDSTATE_DELTA_MIME_TYPE,
  type WorldStateDeltaArtifactData,
} from "../../../lib/types/worldstate-delta.ts";
import {
  COST_V1_MIME_TYPE,
  type CostArtifactData,
} from "../../../lib/types/cost-v1.ts";
import {
  CONFIDENCE_V1_MIME_TYPE,
  type ConfidenceArtifactData,
} from "../../../lib/types/confidence-v1.ts";
import {
  defaultExtensionRegistry,
  type ExtensionContext,
  type ExtensionInterceptor,
} from "../extension-registry.ts";

/**
 * Auth scheme the executor applies on outbound requests.
 *
 *   "apiKey" — sends X-API-Key: <value>    (default — same as legacy behavior)
 *   "bearer" — sends Authorization: Bearer <value>
 *   "hmac"   — reserved for future HMAC-signed requests (extension hook only)
 *
 * `value` resolution: if `valueEnv` is set, we read process.env[valueEnv];
 * otherwise we fall back to the agent-level `apiKeyEnv` for backward compat.
 * Unset → no auth header stamped.
 */
export type A2AAuthScheme = "apiKey" | "bearer" | "hmac";

export interface A2AAuthConfig {
  scheme: A2AAuthScheme;
  /** Environment variable holding the credential value. */
  credentialsEnv?: string;
}

export interface A2AAgentConfig {
  /** Agent name (for logging). */
  name: string;
  /** Full A2A endpoint URL (to agent root — card is fetched at /.well-known/agent-card.json). */
  url: string;
  /** Environment variable name holding the API key. Optional. Legacy alias for auth.apiKey. */
  apiKeyEnv?: string;
  /** Structured auth config — preferred over apiKeyEnv when set. */
  auth?: A2AAuthConfig;
  /** Extra request headers (e.g. opt-in A2A extensions). Merged per-call. */
  extraHeaders?: Record<string, string>;
  /** Request timeout in ms. Default: 300_000 (5 min). */
  timeoutMs?: number;
  /**
   * Whether the remote agent supports SSE streaming. Authoritative source is
   * the agent card's `capabilities.streaming`, refreshed by SkillBrokerPlugin
   * every 10 min via setCapabilities(). YAML value in agents.yaml is a
   * bootstrap default used before the first card fetch lands.
   */
  streaming?: boolean;
  /**
   * Whether the remote agent accepts push-notification registrations. Same
   * source-of-truth story as streaming — card advertises, broker refreshes.
   */
  pushNotifications?: boolean;
  /** Callback for intermediate streaming updates (e.g. publish to bus). */
  onStreamUpdate?: (update: { type: string; text?: string; state?: string }) => void;
  /**
   * Public base URL of the workstacean API server (e.g. http://workstacean:3000
   * on the docker network). Required to register push notification webhooks.
   * If unset, push notifications are skipped and we fall back to polling.
   */
  callbackBaseUrl?: string;
}

export interface ExecuteOptions {
  /**
   * If provided and the agent supports push notifications, the executor
   * registers a push-notification config pointing at this taskId + token
   * so the agent can POST task updates back via /api/a2a/callback/:taskId.
   */
  callback?: { taskId: string; token: string };
}

/**
 * Build a fetch wrapper that stamps auth + per-request trace headers.
 * A new wrapper is built per executor.execute() call so each client sees
 * the right correlationId without requiring a separate cached client per trace.
 *
 * The `as typeof fetch` cast is because TS types `typeof fetch` includes
 * `preconnect` (a browser-only signature) that Node/Bun's fetch doesn't expose.
 */
function buildFetch(
  auth: { scheme: A2AAuthScheme; value: string } | undefined,
  extraHeaders: Record<string, string> | undefined,
  timeoutMs: number,
  correlationId: string,
  parentId?: string,
): typeof fetch {
  const wrapped = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);

    // Auth header selection — scheme drives the header name.
    if (auth && auth.value) {
      if (auth.scheme === "bearer") {
        headers.set("Authorization", `Bearer ${auth.value}`);
      } else if (auth.scheme === "apiKey") {
        headers.set("X-API-Key", auth.value);
      }
      // "hmac" is handled by an extension interceptor, not here.
    }

    // Static extra headers (e.g. a2a-extensions opt-in list). Don't overwrite
    // anything the SDK already set — extras are for our metadata only.
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        if (!headers.has(k)) headers.set(k, v);
      }
    }

    headers.set("X-Correlation-Id", correlationId);
    if (parentId) headers.set("X-Parent-Id", parentId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, headers, signal: init?.signal ?? controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  return wrapped as typeof fetch;
}

export class A2AExecutor implements IExecutor {
  readonly type = "a2a";

  constructor(private config: A2AAgentConfig) {}

  /** Expose name for diagnostics / registry wiring. */
  get name(): string {
    return this.config.name;
  }

  /** Expose the configured agent URL so the dispatcher can pick an appropriate callback base URL. */
  get url(): string {
    return this.config.url;
  }

  /**
   * Update the streaming + pushNotifications capability flags from the agent
   * card. Called by SkillBrokerPlugin after every card discovery pass so the
   * executor picks the right transport path based on what the agent actually
   * advertises, not stale YAML config.
   */
  setCapabilities(caps: { streaming?: boolean; pushNotifications?: boolean }): void {
    this.config = {
      ...this.config,
      streaming: caps.streaming ?? this.config.streaming,
      pushNotifications: caps.pushNotifications ?? this.config.pushNotifications,
    };
  }

  /** Whether this executor is currently configured to use SSE streaming. */
  get streaming(): boolean {
    return this.config.streaming === true;
  }

  /** Whether push-notification registration should be attempted. */
  get pushNotifications(): boolean {
    return this.config.pushNotifications === true;
  }

  async execute(req: SkillRequest): Promise<SkillResult> {
    const text = req.content ?? req.prompt ?? this._buildText(req);

    // Run extension before-hooks — each interceptor may stamp keys onto
    // ctx.metadata, which gets merged into the outbound JSON-RPC metadata.
    // Interceptors self-gate on agent-specific data (they no-op when the
    // agent card doesn't advertise their URI or the response lacks the
    // expected fields), so running all registered extensions is safe.
    const interceptors = defaultExtensionRegistry.list()
      .map(d => d.interceptor)
      .filter((i): i is ExtensionInterceptor => !!i);
    const extCtx: ExtensionContext = {
      agentName: this.config.name,
      skill: req.skill,
      correlationId: req.correlationId,
      metadata: {},
    };
    for (const i of interceptors) {
      try {
        await i.before?.(extCtx);
      } catch (err) {
        console.debug(`[a2a-executor] extension before-hook error:`, err);
      }
    }

    try {
      // Per-request client so trace headers get stamped via the fetch wrapper.
      const client = await this._buildClient(req.correlationId, req.parentId);

      const params = {
        message: {
          kind: "message" as const,
          messageId: crypto.randomUUID(),
          role: "user" as const,
          parts: [{ kind: "text" as const, text }],
          contextId: req.contextId ?? req.correlationId,
        },
        metadata: {
          skillHint: req.skill,
          correlationId: req.correlationId,
          parentId: req.parentId,
          ...req.payload,
          ...extCtx.metadata,
        },
      };

      let result = this.config.streaming
        ? await this._executeStream(client, params, req)
        : await this._executeBlocking(client, params, req);

      // Graceful degradation: if the streaming path returned nothing usable
      // (no taskId, no terminal text), the agent's SSE events likely don't
      // match the @a2a-js/sdk discriminator shape (missing `kind` field or
      // similar). Fall through to message/send so the dispatcher + TaskTracker
      // still get a proper Task handle to work with. Logs the slip so we can
      // spot agents that need a spec-compliance fix.
      if (this.config.streaming && !result.isError
        && !result.data?.taskId
        && (!result.text || result.text.startsWith(`Skill "${req.skill}" completed by`))) {
        console.warn(
          `[a2a-executor] ${this.config.name}: streaming returned empty result — falling back to message/send (agent SSE events may be missing "kind" field)`,
        );
        result = await this._executeBlocking(client, params, req);
      }

      // Run extension after-hooks — they read result.data (usage, confidence,
      // worldstate-delta) and emit observability events or record samples.
      for (const i of interceptors) {
        try {
          await i.after?.(extCtx, { text: result.text, data: result.data });
        } catch (err) {
          console.debug(`[a2a-executor] extension after-hook error:`, err);
        }
      }

      return result;
    } catch (err) {
      return {
        text: err instanceof Error ? err.message : String(err),
        isError: true,
        correlationId: req.correlationId,
      };
    }
  }

  /**
   * Resume a task that's in input-required state by sending a new message
   * with the same taskId. Used by TaskTracker when a HITL response arrives.
   */
  async resumeTask(
    taskId: string,
    contextId: string,
    text: string,
    correlationId: string,
    parentId?: string,
  ): Promise<void> {
    const client = await this._buildClient(correlationId, parentId);
    await client.sendMessage({
      message: {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text }],
        taskId,
        contextId,
      },
    });
  }

  /**
   * Register a push-notification webhook for a task. Agent will POST Task
   * snapshots to the URL with the given token in X-A2A-Notification-Token
   * when the task state changes. Silently no-ops if the agent doesn't
   * support push notifications (we fall back to polling).
   */
  async registerPushNotification(
    taskId: string,
    callbackUrl: string,
    token: string,
    correlationId: string,
    parentId?: string,
  ): Promise<boolean> {
    try {
      const client = await this._buildClient(correlationId, parentId);
      await client.setTaskPushNotificationConfig({
        taskId,
        pushNotificationConfig: { url: callbackUrl, token },
      });
      return true;
    } catch (err) {
      // Agent doesn't support push notifications — tracker falls back to polling
      console.log(
        `[a2a-executor] ${this.config.name}: push-notification register failed for ${taskId.slice(0, 8)}… — ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Poll a task for its current state. Used by TaskTracker to check progress
   * on long-running tasks without blocking the executor loop.
   */
  async pollTask(taskId: string, correlationId: string, parentId?: string): Promise<SkillResult> {
    try {
      const client = await this._buildClient(correlationId, parentId);
      const task = await client.getTask({ id: taskId });
      const artifactText = (task.artifacts ?? [])
        .flatMap(a => a.parts)
        .filter((p): p is { kind: "text"; text: string } => p.kind === "text" && typeof p.text === "string")
        .map(p => p.text)
        .join("\n");
      const statusText = task.status.message ? this._textFromParts(task.status.message.parts) : "";
      return {
        text: artifactText || statusText || "",
        isError: task.status.state === "failed" || task.status.state === "rejected",
        correlationId,
        data: {
          taskId: task.id,
          contextId: task.contextId,
          taskState: task.status.state,
          artifacts: task.artifacts ?? [],
        },
      };
    } catch (err) {
      return {
        text: err instanceof Error ? err.message : String(err),
        isError: true,
        correlationId,
      };
    }
  }

  /**
   * Cancel an in-flight task. Idempotent: already-terminal tasks throw
   * TaskNotCancelableError which we surface as isError.
   */
  async cancelTask(taskId: string, correlationId: string, parentId?: string): Promise<SkillResult> {
    try {
      const client = await this._buildClient(correlationId, parentId);
      const task = await client.cancelTask({ id: taskId });
      return {
        text: `Task ${taskId} canceled`,
        isError: false,
        correlationId,
        data: { taskId: task.id, contextId: task.contextId, taskState: task.status.state },
      };
    } catch (err) {
      return {
        text: err instanceof Error ? err.message : String(err),
        isError: true,
        correlationId,
      };
    }
  }

  /**
   * Resubscribe to a task's SSE stream after connection drops. Yields events
   * just like sendMessageStream; TaskTracker can prefer this over polling
   * when the agent card says capabilities.streaming: true.
   */
  async resubscribeTask(
    taskId: string,
    correlationId: string,
    parentId?: string,
  ): Promise<AsyncGenerator<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent, void, undefined>> {
    const client = await this._buildClient(correlationId, parentId);
    return client.resubscribeTask({ id: taskId });
  }

  /**
   * Non-streaming path: client.sendMessage returns Message | Task.
   */
  private async _executeBlocking(
    client: Client,
    params: Parameters<Client["sendMessage"]>[0],
    req: SkillRequest,
  ): Promise<SkillResult> {
    const result = await client.sendMessage(params);

    // Result can be a Message (immediate agent reply, no task) or a Task (may still be working).
    if (result.kind === "message") {
      const text = this._textFromParts(result.parts);
      return {
        text,
        isError: false,
        correlationId: req.correlationId,
        data: { taskState: "completed" },
      };
    }

    // Task — extract text from artifacts or status.message.parts
    const task = result;
    const artifactText = (task.artifacts ?? [])
      .flatMap(a => a.parts)
      .filter((p): p is { kind: "text"; text: string } => p.kind === "text" && typeof p.text === "string")
      .map(p => p.text)
      .join("\n");

    const statusText = task.status.message
      ? this._textFromParts(task.status.message.parts)
      : "";

    const text = artifactText || statusText || `Skill "${req.skill}" accepted by ${this.config.name}`;
    const taskState = task.status.state;

    const worldStateDelta = this._extractWorldStateDelta(task);
    const allParts = (task.artifacts ?? []).flatMap(a => a.parts);
    const cost = this._costFromParts(allParts);
    const confidence = this._confidenceFromParts(allParts);

    return {
      text,
      isError: taskState === "failed" || taskState === "rejected",
      correlationId: req.correlationId,
      data: {
        taskId: task.id,
        contextId: task.contextId,
        taskState,
        ...(worldStateDelta ? { [WORLDSTATE_DELTA_MIME_TYPE]: worldStateDelta } : {}),
        ...this._flattenExtensionData(cost, confidence, taskState),
      },
    };
  }

  /**
   * Streaming path: iterates the SSE event stream, accumulates artifact text.
   * Supports artifact chunking via append/lastChunk (Phase 5 honors this fully).
   */
  private async _executeStream(
    client: Client,
    params: Parameters<Client["sendMessageStream"]>[0],
    req: SkillRequest,
  ): Promise<SkillResult> {
    let taskId: string | undefined;
    let contextId: string | undefined;
    let taskState = "working";
    let terminalMessage = "";

    // Artifact buffering — honors append + lastChunk per A2A spec.
    // - append: false (or undefined) → replace the artifact's parts
    // - append: true → concatenate incoming parts to existing buffer
    // - lastChunk: true → signal artifact is complete (we emit artifact_complete)
    const artifactBuffers = new Map<string, Array<{ kind: string; text?: string }>>();
    // Collect worldstate-delta DataParts seen during streaming.
    const streamDeltaData: Record<string, unknown> = {};

    for await (const event of client.sendMessageStream(params)) {
      if (event.kind === "message") {
        // Terminal message — stream ends
        terminalMessage = this._textFromParts(event.parts);
        taskState = "completed";
        break;
      }
      if (event.kind === "task") {
        taskId = event.id;
        contextId = event.contextId;
        taskState = event.status.state;
        // Seed artifact buffers from task snapshot if present
        for (const artifact of event.artifacts ?? []) {
          artifactBuffers.set(artifact.artifactId, [...artifact.parts]);
          // Extract worldstate-delta parts from seeded task snapshot
          const delta = this._worldStateDeltaFromParts(artifact.parts);
          if (delta) streamDeltaData[WORLDSTATE_DELTA_MIME_TYPE] = delta;
        }
        // Non-terminal state (submitted / working / input-required) on the
        // initial task event → stop consuming the SSE stream and let
        // TaskTracker drive the task to completion via tasks/get polling.
        // Holding the stream open longer forces slow agents to keep their
        // SSE generator alive for minutes, which crashes them when the
        // sync caller eventually times out and closes the connection.
        if (taskState !== "completed" && taskState !== "failed"
          && taskState !== "canceled" && taskState !== "rejected") {
          break;
        }
        continue;
      }
      if (event.kind === "status-update") {
        taskId = event.taskId;
        contextId = event.contextId;
        taskState = event.status.state;
        const statusText = event.status.message ? this._textFromParts(event.status.message.parts) : "";
        if (statusText) {
          this.config.onStreamUpdate?.({ type: "status", text: statusText, state: taskState });
        }
        if (event.final) break;
        continue;
      }
      if (event.kind === "artifact-update") {
        taskId = event.taskId;
        contextId = event.contextId;
        const aid = event.artifact.artifactId;
        const incomingParts = event.artifact.parts;
        const incomingText = this._textFromParts(incomingParts);

        if (event.append) {
          const existing = artifactBuffers.get(aid) ?? [];
          artifactBuffers.set(aid, [...existing, ...incomingParts]);
        } else {
          // New artifact or replacement
          artifactBuffers.set(aid, [...incomingParts]);
        }

        // Extract worldstate-delta DataParts as they arrive
        const delta = this._worldStateDeltaFromParts(incomingParts);
        if (delta) streamDeltaData[WORLDSTATE_DELTA_MIME_TYPE] = delta;

        // Emit chunk event — consumers see progressive updates in real time
        if (incomingText) {
          this.config.onStreamUpdate?.({
            type: event.append ? "artifact_chunk" : "artifact",
            text: incomingText,
          });
        }
        if (event.lastChunk) {
          const finalText = this._textFromParts(artifactBuffers.get(aid) ?? []);
          this.config.onStreamUpdate?.({
            type: "artifact_complete",
            text: finalText,
          });
        }
      }
    }

    // Final resultText = terminal message if we got one, otherwise concat of all artifact buffers
    const artifactText = Array.from(artifactBuffers.values())
      .map(parts => this._textFromParts(parts))
      .filter(Boolean)
      .join("\n");
    const resultText = terminalMessage || artifactText;

    // Scan accumulated artifact parts for cost-v1 + confidence-v1 payloads
    // and flatten them onto result.data the same way the blocking path does.
    const allStreamParts = Array.from(artifactBuffers.values()).flat();
    const cost = this._costFromParts(allStreamParts);
    const confidence = this._confidenceFromParts(allStreamParts);

    return {
      text: resultText || `Skill "${req.skill}" completed by ${this.config.name}`,
      isError: taskState === "failed" || taskState === "rejected",
      correlationId: req.correlationId,
      data: {
        taskId,
        contextId,
        taskState,
        ...streamDeltaData,
        ...this._flattenExtensionData(cost, confidence, taskState),
      },
    };
  }

  private _textFromParts(parts: Array<{ kind: string; text?: string }>): string {
    return parts
      .filter((p): p is { kind: "text"; text: string } => p.kind === "text" && typeof p.text === "string")
      .map(p => p.text)
      .join("");
  }

  /**
   * Scan a Task's artifact parts for a worldstate-delta DataPart.
   * Returns the first match's payload, or undefined if none found.
   */
  private _extractWorldStateDelta(task: Task): WorldStateDeltaArtifactData | undefined {
    for (const artifact of task.artifacts ?? []) {
      const result = this._worldStateDeltaFromParts(artifact.parts);
      if (result) return result;
    }
    return undefined;
  }

  /**
   * Scan a parts array for a worldstate-delta DataPart (kind: "data",
   * metadata.mimeType === WORLDSTATE_DELTA_MIME_TYPE). Returns the first match.
   */
  private _worldStateDeltaFromParts(
    parts: Array<{ kind: string; data?: Record<string, unknown>; metadata?: Record<string, unknown> }>,
  ): WorldStateDeltaArtifactData | undefined {
    for (const part of parts) {
      if (
        part.kind === "data" &&
        part.metadata?.["mimeType"] === WORLDSTATE_DELTA_MIME_TYPE &&
        part.data
      ) {
        return part.data as unknown as WorldStateDeltaArtifactData;
      }
    }
    return undefined;
  }

  /** Scan artifact parts for a cost-v1 DataPart and return the first match. */
  private _costFromParts(
    parts: Array<{ kind: string; data?: Record<string, unknown>; metadata?: Record<string, unknown> }>,
  ): CostArtifactData | undefined {
    for (const part of parts) {
      if (
        part.kind === "data" &&
        part.metadata?.["mimeType"] === COST_V1_MIME_TYPE &&
        part.data
      ) {
        return part.data as unknown as CostArtifactData;
      }
    }
    return undefined;
  }

  /** Scan artifact parts for a confidence-v1 DataPart and return the first match. */
  private _confidenceFromParts(
    parts: Array<{ kind: string; data?: Record<string, unknown>; metadata?: Record<string, unknown> }>,
  ): ConfidenceArtifactData | undefined {
    for (const part of parts) {
      if (
        part.kind === "data" &&
        part.metadata?.["mimeType"] === CONFIDENCE_V1_MIME_TYPE &&
        part.data
      ) {
        return part.data as unknown as ConfidenceArtifactData;
      }
    }
    return undefined;
  }

  /**
   * Flatten cost-v1 + confidence-v1 DataPart payloads onto the fields the
   * extension interceptors already read off `result.data`. Call sites merge
   * the returned object into their `data` spread.
   */
  private _flattenExtensionData(
    cost: CostArtifactData | undefined,
    confidence: ConfidenceArtifactData | undefined,
    taskState: string,
  ): Record<string, unknown> {
    return {
      ...(cost && {
        usage: cost.usage,
        ...(typeof cost.durationMs === "number" ? { durationMs: cost.durationMs } : {}),
        ...(typeof cost.costUsd === "number" ? { costUsd: cost.costUsd } : {}),
        success: cost.success ?? (taskState === "completed"),
      }),
      ...(confidence && {
        confidence: confidence.confidence,
        ...(typeof confidence.explanation === "string"
          ? { confidenceExplanation: confidence.explanation }
          : {}),
      }),
    };
  }

  /**
   * Build a Client with per-request trace headers. A new client per-call is
   * the simplest way to inject correlationId/parentId via the fetch layer —
   * ClientFactory / ClientConfig don't expose a per-call header hook.
   * The agent card fetch is the only cacheable cost; we accept the overhead
   * today and can add card-level caching in Phase 4.
   */
  private async _buildClient(correlationId: string, parentId?: string): Promise<Client> {
    const baseUrl = this.config.url.replace(/\/a2a\/?$/, "");
    const timeoutMs = this.config.timeoutMs ?? 300_000;

    // Auth resolution — prefer structured auth.credentialsEnv; fall back to
    // the legacy apiKeyEnv so existing agents.yaml keeps working.
    const scheme: A2AAuthScheme = this.config.auth?.scheme ?? "apiKey";
    const credEnv = this.config.auth?.credentialsEnv ?? this.config.apiKeyEnv;
    const credValue = credEnv ? (process.env[credEnv] ?? "") : "";
    const authOpts = credValue ? { scheme, value: credValue } : undefined;

    const customFetch = buildFetch(
      authOpts,
      this.config.extraHeaders,
      timeoutMs,
      correlationId,
      parentId,
    );
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: customFetch })],
    });

    try {
      return await factory.createFromUrl(baseUrl);
    } catch (err) {
      // Fallback to legacy path — some servers still serve /.well-known/agent.json
      // instead of the newer /.well-known/agent-card.json
      try {
        return await factory.createFromUrl(baseUrl, "/.well-known/agent.json");
      } catch {
        throw err;
      }
    }
  }

  private _buildText(req: SkillRequest): string {
    return [
      `Execute skill: ${req.skill}`,
      ...Object.entries(req.payload)
        .filter(([k]) => !["skill", "replyTopic", "correlationId", "parentId"].includes(k))
        .map(([k, v]) => {
          if (typeof v !== "object") return `${k}: ${String(v)}`;
          try { return `${k}: ${JSON.stringify(v)}`; } catch { return `${k}: [unserializable]`; }
        }),
    ].join("\n");
  }
}

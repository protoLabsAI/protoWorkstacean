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
import type { AgentCard } from "@a2a-js/sdk";
import {
  Role,
  TaskState,
  type Message,
  type Part,
  type StreamResponse,
  type Task,
} from "@a2a-js/sdk";
import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";
import {
  WORLDSTATE_DELTA_MIME_TYPE,
  parseWorldStateDelta,
  parseCost,
  parseConfidence,
  textPart,
  partText,
  stampAuthHeader,
  isTerminalState,
  isErrorState,
  stateToLegacyString,
  type WorldStateDeltaArtifactData,
  type CostArtifactData,
  type ConfidenceArtifactData,
  type A2AAuthScheme,
} from "@protolabs/a2a";
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
  /**
   * Agent runs on an external network (Tailscale, public Internet) rather
   * than the shared docker network. Consumed by SkillDispatcherPlugin to
   * pick the correct push-notification callback base URL — internal agents
   * get WORKSTACEAN_INTERNAL_BASE_URL (docker service name), externals get
   * WORKSTACEAN_BASE_URL (Tailscale / public hostname).
   */
  external?: boolean;
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
      stampAuthHeader(headers, auth.scheme, auth.value);
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

/**
 * A2A 1.0 dropped the `kind` discriminator from SendMessageResult (Message | Task).
 * A Task has a string `id` + a `status` slot; a Message has a `messageId`.
 * Discriminate structurally. (Part/state helpers live in @protolabs/a2a.)
 */
function isTask(result: Message | Task): result is Task {
  return "id" in result && "status" in result;
}

/**
 * Pin an agent card's transport URL(s) to `url`. Agents — especially
 * containerized / NAT'd ones — sometimes self-advertise an unreachable
 * interface URL in their card (e.g. `http://127.0.0.1:7870/a2a`). The
 * operator-configured `agents.d` URL is authoritative for reachability, so we
 * use the card for discovery (skills/extensions/capabilities) but connect to
 * the configured URL. Returns a shallow copy; does not mutate the input. (#760)
 */
export function pinCardTransportUrl(card: AgentCard, url: string): AgentCard {
  const pinned: AgentCard = { ...card };
  if (Array.isArray(card.supportedInterfaces)) {
    pinned.supportedInterfaces = card.supportedInterfaces.map(iface => ({ ...iface, url }));
  }
  // Legacy 0.3 top-level `url`, if a server still emits it.
  if ((card as { url?: string }).url) (pinned as { url?: string }).url = url;
  return pinned;
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

  /** True when the agent runs on an external network — dispatcher uses WORKSTACEAN_BASE_URL for callbacks. */
  get external(): boolean {
    return this.config.external === true;
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

      const params = this._buildSendRequest(text, req.contextId ?? req.correlationId, {
        skillHint: req.skill,
        correlationId: req.correlationId,
        parentId: req.parentId,
        ...req.payload,
        ...extCtx.metadata,
      });

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
    await client.sendMessage(this._buildSendRequest(text, contextId, undefined, taskId));
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
      // A2A 1.0: setTaskPushNotificationConfig → createTaskPushNotificationConfig,
      // and the param is a flat TaskPushNotificationConfig (no nested
      // pushNotificationConfig wrapper). `id` is the config id (empty = default).
      await client.createTaskPushNotificationConfig({
        tenant: "",
        id: "",
        taskId,
        url: callbackUrl,
        token,
        authentication: undefined,
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
      const task = await client.getTask({ tenant: "", id: taskId });
      const state = task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
      const allParts = (task.artifacts ?? []).flatMap(a => a.parts);
      const artifactText = this._textFromParts(allParts);
      const statusText = task.status?.message ? this._textFromParts(task.status.message.parts) : "";
      // Extract extension DataParts here too — most real tasks complete via this
      // poll path (the stream loop breaks to tasks/get on the first non-terminal
      // task event), so without this the cost-v1/confidence-v1/worldstate-delta
      // parts an agent emits never reach result.data and are silently dropped.
      // Mirrors the blocking + stream-to-terminal paths.
      const taskState = stateToLegacyString(state);
      const worldStateDelta = this._extractWorldStateDelta(task);
      const cost = this._costFromParts(allParts);
      const confidence = this._confidenceFromParts(allParts);
      return {
        text: artifactText || statusText || "",
        isError: isErrorState(state),
        correlationId,
        data: {
          taskId: task.id,
          contextId: task.contextId,
          taskState,
          artifacts: task.artifacts ?? [],
          ...(worldStateDelta ? { [WORLDSTATE_DELTA_MIME_TYPE]: worldStateDelta } : {}),
          ...this._flattenExtensionData(cost, confidence, taskState),
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
      const task = await client.cancelTask({ tenant: "", id: taskId, metadata: undefined });
      return {
        text: `Task ${taskId} canceled`,
        isError: false,
        correlationId,
        data: {
          taskId: task.id,
          contextId: task.contextId,
          taskState: stateToLegacyString(task.status?.state ?? TaskState.TASK_STATE_CANCELED),
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
   * Resubscribe to a task's SSE stream after connection drops. Yields events
   * just like sendMessageStream; TaskTracker can prefer this over polling
   * when the agent card says capabilities.streaming: true.
   */
  async resubscribeTask(
    taskId: string,
    correlationId: string,
    parentId?: string,
  ): Promise<AsyncGenerator<StreamResponse, void, undefined>> {
    const client = await this._buildClient(correlationId, parentId);
    return client.resubscribeTask({ tenant: "", id: taskId });
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

    // A2A 1.0: SendMessageResult is Message | Task with no `kind` discriminator.
    // Discriminate structurally — a Task carries an `id` + `status`, a Message
    // carries `messageId` + `parts`. A Message is an immediate agent reply (no task).
    if (!isTask(result)) {
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
    const artifactText = this._textFromParts((task.artifacts ?? []).flatMap(a => a.parts));
    const statusText = task.status?.message
      ? this._textFromParts(task.status.message.parts)
      : "";

    const text = artifactText || statusText || `Skill "${req.skill}" accepted by ${this.config.name}`;
    const state = task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
    const taskState = stateToLegacyString(state);

    const worldStateDelta = this._extractWorldStateDelta(task);
    const allParts = (task.artifacts ?? []).flatMap(a => a.parts);
    const cost = this._costFromParts(allParts);
    const confidence = this._confidenceFromParts(allParts);

    return {
      text,
      isError: isErrorState(state),
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
    let state: TaskState = TaskState.TASK_STATE_WORKING;
    let terminalMessage = "";

    // Artifact buffering — honors append + lastChunk per A2A spec.
    // - append: false (or undefined) → replace the artifact's parts
    // - append: true → concatenate incoming parts to existing buffer
    // - lastChunk: true → signal artifact is complete (we emit artifact_complete)
    const artifactBuffers = new Map<string, Part[]>();
    // Collect worldstate-delta DataParts seen during streaming.
    const streamDeltaData: Record<string, unknown> = {};

    // A2A 1.0: stream events are StreamResponse, member-discriminated via
    // `payload.$case` ∈ message | task | statusUpdate | artifactUpdate. The old
    // `final: true` flag is gone — terminal = the task STATE is terminal, or the
    // stream simply closes (the for-await generator ending).
    for await (const event of client.sendMessageStream(params)) {
      const payload = event.payload;
      if (!payload) continue;

      if (payload.$case === "message") {
        // Terminal message — stream ends
        terminalMessage = this._textFromParts(payload.value.parts);
        state = TaskState.TASK_STATE_COMPLETED;
        break;
      }
      if (payload.$case === "task") {
        const task = payload.value;
        taskId = task.id;
        contextId = task.contextId;
        state = task.status?.state ?? TaskState.TASK_STATE_WORKING;
        // Seed artifact buffers from task snapshot if present
        for (const artifact of task.artifacts ?? []) {
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
        if (!isTerminalState(state)) break;
        continue;
      }
      if (payload.$case === "statusUpdate") {
        const upd = payload.value;
        taskId = upd.taskId;
        contextId = upd.contextId;
        state = upd.status?.state ?? state;
        const statusText = upd.status?.message ? this._textFromParts(upd.status.message.parts) : "";
        if (statusText) {
          this.config.onStreamUpdate?.({ type: "status", text: statusText, state: stateToLegacyString(state) });
        }
        // Terminal state signals done (1.0 has no `final` flag).
        if (isTerminalState(state)) break;
        continue;
      }
      if (payload.$case === "artifactUpdate") {
        const upd = payload.value;
        taskId = upd.taskId;
        contextId = upd.contextId;
        const artifact = upd.artifact;
        if (!artifact) continue;
        const aid = artifact.artifactId;
        const incomingParts = artifact.parts;
        const incomingText = this._textFromParts(incomingParts);

        if (upd.append) {
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
            type: upd.append ? "artifact_chunk" : "artifact",
            text: incomingText,
          });
        }
        if (upd.lastChunk) {
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
    const taskState = stateToLegacyString(state);

    return {
      text: resultText || `Skill "${req.skill}" completed by ${this.config.name}`,
      isError: isErrorState(state),
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

  private _textFromParts(parts: Part[]): string {
    return parts
      .map(partText)
      .filter((t): t is string => typeof t === "string")
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

  // Extension DataPart extraction delegates to @protolabs/a2a parse helpers:
  // the structured payload lives in `part.content.value` (when `$case ===
  // "data"`) and the MIME discriminator stays in `part.metadata.mimeType`.

  private _worldStateDeltaFromParts(parts: Part[]): WorldStateDeltaArtifactData | undefined {
    return parseWorldStateDelta(parts);
  }

  /** Scan artifact parts for a cost-v1 DataPart and return the first match. */
  private _costFromParts(parts: Part[]): CostArtifactData | undefined {
    return parseCost(parts);
  }

  /** Scan artifact parts for a confidence-v1 DataPart and return the first match. */
  private _confidenceFromParts(parts: Part[]): ConfidenceArtifactData | undefined {
    return parseConfidence(parts);
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

    // Resolve the card for discovery, then PIN the transport URL to the
    // configured `url`. createFromUrl would connect to the card's self-advertised
    // interface URL, which containerized/NAT'd agents often set to loopback
    // (e.g. http://127.0.0.1:7870/a2a) — unreachable from here, and a single
    // point of failure for the whole edge (#760). The agents.d URL is
    // authoritative for reachability; the card stays the source for skills/extensions.
    const card = await this._fetchAgentCard(baseUrl, customFetch);
    return await factory.createFromAgentCard(pinCardTransportUrl(card, this.config.url));
  }

  /** Fetch the agent card from `baseUrl`, trying the 1.0 path then the legacy 0.3 path. */
  private async _fetchAgentCard(
    baseUrl: string,
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  ): Promise<AgentCard> {
    let lastErr: unknown;
    for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
      try {
        const res = await fetchImpl(`${baseUrl}${path}`);
        if (res.ok) return (await res.json()) as AgentCard;
        lastErr = new Error(`HTTP ${res.status} from ${path}`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `[a2a] could not resolve agent card for ${baseUrl} (tried agent-card.json + agent.json): ` +
      (lastErr instanceof Error ? lastErr.message : String(lastErr)),
    );
  }

  /**
   * Build a A2A 1.0 SendMessageRequest. The Message is fully-populated (1.0
   * Message has no `kind`; `role` is the Role enum; parts are member-
   * discriminated). Request-level `metadata` carries our routing hints
   * (skillHint / correlationId / payload), matching the 0.3 behavior.
   */
  private _buildSendRequest(
    text: string,
    contextId: string,
    metadata: Record<string, unknown> | undefined,
    taskId = "",
  ): import("@a2a-js/sdk").SendMessageRequest {
    const message: Message = {
      messageId: crypto.randomUUID(),
      role: Role.ROLE_USER,
      parts: [textPart(text)],
      contextId,
      taskId,
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    };
    return {
      tenant: "",
      message,
      configuration: undefined,
      metadata,
    };
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

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

export interface A2AAgentConfig {
  /** Agent name (for logging). */
  name: string;
  /** Full A2A endpoint URL (to agent root — card is fetched at /.well-known/agent-card.json). */
  url: string;
  /** Environment variable name holding the API key. Optional. */
  apiKeyEnv?: string;
  /** Request timeout in ms. Default: 300_000 (5 min). */
  timeoutMs?: number;
  /** Whether the remote agent supports SSE streaming (from agent card). */
  streaming?: boolean;
  /** Callback for intermediate streaming updates (e.g. publish to bus). */
  onStreamUpdate?: (update: { type: string; text?: string; state?: string }) => void;
}

/**
 * Build a fetch wrapper that stamps API key + per-request trace headers.
 * A new wrapper is built per executor.execute() call so each client sees
 * the right correlationId without requiring a separate cached client per trace.
 *
 * The `as typeof fetch` cast is because TS types `typeof fetch` includes
 * `preconnect` (a browser-only signature) that Node/Bun's fetch doesn't expose.
 */
function buildFetch(
  apiKey: string,
  timeoutMs: number,
  correlationId: string,
  parentId?: string,
): typeof fetch {
  const wrapped = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (apiKey) headers.set("X-API-Key", apiKey);
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

  constructor(private readonly config: A2AAgentConfig) {}

  async execute(req: SkillRequest): Promise<SkillResult> {
    const text = req.content ?? req.prompt ?? this._buildText(req);

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
        },
      };

      if (this.config.streaming) {
        return await this._executeStream(client, params, req);
      }
      return await this._executeBlocking(client, params, req);
    } catch (err) {
      return {
        text: err instanceof Error ? err.message : String(err),
        isError: true,
        correlationId: req.correlationId,
      };
    }
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

    return {
      text,
      isError: taskState === "failed" || taskState === "rejected",
      correlationId: req.correlationId,
      data: {
        taskId: task.id,
        contextId: task.contextId,
        taskState,
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
    let resultText = "";
    let taskId: string | undefined;
    let contextId: string | undefined;
    let taskState = "working";

    for await (const event of client.sendMessageStream(params)) {
      if (event.kind === "message") {
        // Terminal message — stream ends
        resultText = this._textFromParts(event.parts);
        taskState = "completed";
        break;
      }
      if (event.kind === "task") {
        taskId = event.id;
        contextId = event.contextId;
        taskState = event.status.state;
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
        const artifactText = this._textFromParts(event.artifact.parts);
        if (artifactText) {
          resultText += (resultText ? "\n" : "") + artifactText;
          this.config.onStreamUpdate?.({ type: "artifact", text: artifactText });
        }
      }
    }

    return {
      text: resultText || `Skill "${req.skill}" completed by ${this.config.name}`,
      isError: taskState === "failed" || taskState === "rejected",
      correlationId: req.correlationId,
      data: { taskId, contextId, taskState },
    };
  }

  private _textFromParts(parts: Array<{ kind: string; text?: string }>): string {
    return parts
      .filter((p): p is { kind: "text"; text: string } => p.kind === "text" && typeof p.text === "string")
      .map(p => p.text)
      .join("");
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
    const apiKey = this.config.apiKeyEnv ? (process.env[this.config.apiKeyEnv] ?? "") : "";
    const timeoutMs = this.config.timeoutMs ?? 300_000;

    const customFetch = buildFetch(apiKey, timeoutMs, correlationId, parentId);
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

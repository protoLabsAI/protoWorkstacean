/**
 * A2AExecutor — dispatches a skill to an external agent via A2A JSON-RPC (HTTP).
 *
 * Passes correlationId and parentId as HTTP headers (X-Correlation-Id, X-Parent-Id)
 * so the receiving service can propagate the distributed trace.
 *
 * Registered by SkillBrokerPlugin during install().
 */

import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";
import { HttpClient } from "../../services/http-client.ts";

export interface A2AAgentConfig {
  /** Agent name (for logging). */
  name: string;
  /** Full A2A endpoint URL. */
  url: string;
  /** Environment variable name holding the API key. Optional. */
  apiKeyEnv?: string;
  /** Request timeout in ms. Default: 300_000 (5 min — agent-driven chats with
   * multiple tool calls routinely exceed 2 min). */
  timeoutMs?: number;
  /** Whether the remote agent supports SSE streaming (from agent card). */
  streaming?: boolean;
  /** Callback for intermediate streaming updates (e.g. publish to bus). */
  onStreamUpdate?: (update: { type: string; text?: string; state?: string }) => void;
}

export class A2AExecutor implements IExecutor {
  readonly type = "a2a";
  private readonly http: HttpClient;

  constructor(private readonly config: A2AAgentConfig) {
    this.http = new HttpClient({ timeoutMs: config.timeoutMs ?? 300_000 });
  }

  async execute(req: SkillRequest): Promise<SkillResult> {
    const apiKey = this.config.apiKeyEnv
      ? (process.env[this.config.apiKeyEnv] ?? "")
      : "";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Distributed trace headers — received by ava's A2A handler
      "X-Correlation-Id": req.correlationId,
      ...(req.parentId ? { "X-Parent-Id": req.parentId } : {}),
    };
    if (apiKey) headers["X-API-Key"] = apiKey;

    const text = req.content ?? req.prompt ?? this._buildText(req);

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text }],
        },
        // contextId carries conversation state; correlationId is the trace ID
        contextId: req.contextId ?? req.correlationId,
        metadata: {
          skillHint: req.skill,
          correlationId: req.correlationId,
          parentId: req.parentId,
          ...req.payload,
        },
      },
    });

    // If agent supports streaming, use SSE for intermediate updates
    if (this.config.streaming) {
      const streamBody = body.replace('"message/send"', '"message/sendStream"');
      const streamHeaders = { ...headers, Accept: "text/event-stream" };
      try {
        const streamResult = await this._executeStream(streamHeaders, streamBody, req);
        if (streamResult) return streamResult;
      } catch {
        // Fall through to blocking path
      }
    }

    const resp = await this.http.fetch(this.config.url, {
      method: "POST",
      headers,
      body,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(no body)");
      return {
        text: "",
        isError: true,
        correlationId: req.correlationId,
      };
    }

    // Google A2A protocol response shape:
    //   result: {
    //     id, contextId, status: { state: "completed" },
    //     artifacts: [{ artifactId, parts: [{ kind: "text", text: "..." }] }]
    //   }
    //
    // We flatten all text parts across all artifacts into a single string
    // so callers (skill-dispatcher) get the actual agent reply, not a generic
    // "accepted" stub. Fallback cascade: artifacts.parts.text → result.message
    // (legacy shape) → generic placeholder. Also logs the parse path on debug
    // so future regressions are visible.
    const data = (await resp.json()) as {
      error?: { message: string };
      result?: {
        id?: string;
        contextId?: string;
        status?: { state?: string } | string;
        message?: string;
        artifacts?: Array<{ parts?: Array<{ kind?: string; text?: string }> }>;
        [key: string]: unknown;
      };
    };

    if (data.error) {
      return { text: data.error.message, isError: true, correlationId: req.correlationId };
    }

    const artifactTexts = (data.result?.artifacts ?? [])
      .flatMap((a) => a.parts ?? [])
      .filter((p) => p.kind === "text" && typeof p.text === "string")
      .map((p) => p.text as string);

    const resultText =
      artifactTexts.length > 0
        ? artifactTexts.join("\n")
        : data.result?.message ?? `Skill "${req.skill}" accepted by ${this.config.name}`;

    const statusObj = data.result?.status;
    const taskState = typeof statusObj === "object" ? statusObj?.state : typeof statusObj === "string" ? statusObj : undefined;

    return {
      text: resultText,
      isError: false,
      correlationId: req.correlationId,
      data: {
        ...(data.result?.data as Record<string, unknown> | undefined),
        taskId: data.result?.id as string | undefined,
        contextId: data.result?.contextId as string | undefined,
        taskState,
      },
    };
  }

  /**
   * SSE streaming path — reads TaskStatusUpdateEvent / TaskArtifactUpdateEvent
   * from the response stream. Returns null if the agent doesn't support streaming.
   */
  private async _executeStream(
    headers: Record<string, string>,
    body: string,
    req: SkillRequest,
  ): Promise<SkillResult | null> {
    const resp = await this.http.fetch(this.config.url, {
      method: "POST",
      headers,
      body,
    });

    if (!resp.ok || !resp.body) return null;

    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Not SSE — let caller fall back to blocking path
      return null;
    }

    let resultText = "";
    let taskId: string | undefined;
    let contextId: string | undefined;
    let taskState = "working";

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === "[DONE]") continue;

          try {
            const event = JSON.parse(raw) as {
              id?: string;
              contextId?: string;
              status?: { state?: string; message?: { parts?: Array<{ text?: string }> } };
              artifact?: { parts?: Array<{ kind?: string; text?: string }> };
            };

            taskId = event.id ?? taskId;
            contextId = event.contextId ?? contextId;

            if (event.status?.state) {
              taskState = event.status.state;
              const statusText = event.status.message?.parts
                ?.map(p => p.text).filter(Boolean).join("") ?? "";
              if (statusText) {
                this.config.onStreamUpdate?.({ type: "status", text: statusText, state: taskState });
              }
            }

            if (event.artifact) {
              const artifactText = (event.artifact.parts ?? [])
                .filter(p => p.kind === "text" && p.text)
                .map(p => p.text).join("");
              if (artifactText) {
                resultText += (resultText ? "\n" : "") + artifactText;
                this.config.onStreamUpdate?.({ type: "artifact", text: artifactText });
              }
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      text: resultText || `Skill "${req.skill}" completed by ${this.config.name}`,
      isError: taskState === "failed",
      correlationId: req.correlationId,
      data: { taskId, contextId, taskState },
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

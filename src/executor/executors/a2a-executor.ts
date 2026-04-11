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
        // contextId carries the trace ID across the boundary
        contextId: req.correlationId,
        metadata: {
          skillHint: req.skill,
          correlationId: req.correlationId,
          parentId: req.parentId,
          ...req.payload,
        },
      },
    });

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

    return {
      text: resultText,
      isError: false,
      correlationId: req.correlationId,
      data: data.result?.data as SkillResult["data"] | undefined,
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

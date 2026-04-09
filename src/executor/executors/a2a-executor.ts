/**
 * A2AExecutor — dispatches a skill to an external agent via A2A JSON-RPC (HTTP).
 *
 * Passes correlationId and parentId as HTTP headers (X-Correlation-Id, X-Parent-Id)
 * so the receiving service can propagate the distributed trace.
 *
 * Registered by SkillBrokerPlugin during install().
 */

import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";

export interface A2AAgentConfig {
  /** Agent name (for logging). */
  name: string;
  /** Full A2A endpoint URL. */
  url: string;
  /** Environment variable name holding the API key. Optional. */
  apiKeyEnv?: string;
  /** Request timeout in ms. Default: 110_000 (just under the 120s ceremony timeout). */
  timeoutMs?: number;
}

export class A2AExecutor implements IExecutor {
  readonly type = "a2a";

  constructor(private readonly config: A2AAgentConfig) {}

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

    const resp = await fetch(this.config.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 110_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(no body)");
      return {
        text: "",
        isError: true,
        correlationId: req.correlationId,
        data: { httpStatus: resp.status, body: errText },
      };
    }

    const data = (await resp.json()) as {
      error?: { message: string };
      result?: { status?: string; message?: string; [key: string]: unknown };
    };

    if (data.error) {
      return { text: "", isError: true, correlationId: req.correlationId, data: { error: data.error.message } };
    }

    const resultText = data.result?.message ?? `Skill "${req.skill}" accepted by ${this.config.name}`;
    return { text: resultText, isError: false, correlationId: req.correlationId, data: data.result };
  }

  private _buildText(req: SkillRequest): string {
    return [
      `Execute skill: ${req.skill}`,
      ...Object.entries(req.payload)
        .filter(([k]) => !["skill", "replyTopic", "correlationId", "parentId"].includes(k))
        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`),
    ].join("\n");
  }
}

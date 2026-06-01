/**
 * McpExecutor — exposes a single MCP tool as an IExecutor (ADR-0005 P4).
 *
 * One McpExecutor per (server, tool). It does NOT own the MCP connection — the
 * McpClientPlugin owns one shared `Client` per server (connected once, reused by
 * every tool) and closes it on unregister. So `dispose()` here is a no-op: an
 * executor must never tear down a connection its sibling tools still use.
 *
 * execute() maps the skill request's `content` (expected to be a JSON object of
 * tool arguments) into an MCP `callTool`, and flattens the tool's content parts
 * back into SkillResult.text.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { IExecutor, SkillRequest, SkillResult } from "../executor/types.ts";

/** Parse the request content into MCP tool arguments. A JSON object is used as-is;
 *  any other content is passed under `input` so simple single-arg tools still work. */
export function toToolArguments(content: string | undefined): Record<string, unknown> {
  const raw = (content ?? "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON — fall through
  }
  return { input: raw };
}

/** Flatten an MCP callTool result's content parts into a single text string. */
export function flattenToolContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") return p.text;
      if (p.type === "image") return `[image ${(p.mimeType as string) ?? ""}]`;
      if (p.type === "resource") return `[resource]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export class McpExecutor implements IExecutor {
  readonly type = "mcp";

  constructor(
    /** Shared, already-connected client owned by McpClientPlugin. */
    private readonly client: Client,
    readonly serverName: string,
    readonly toolName: string,
    readonly toolDescription?: string,
  ) {}

  async execute(req: SkillRequest): Promise<SkillResult> {
    try {
      const result = await this.client.callTool({
        name: this.toolName,
        arguments: toToolArguments(req.content ?? req.prompt),
      });
      const text = flattenToolContent(result.content);
      return {
        text,
        isError: result.isError === true,
        correlationId: req.correlationId,
      };
    } catch (err) {
      return {
        text: `MCP tool "${this.serverName}.${this.toolName}" failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        correlationId: req.correlationId,
      };
    }
  }

  /** No-op: the plugin owns the shared client's lifecycle (see class doc). */
  dispose(): void {}
}

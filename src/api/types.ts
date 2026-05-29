/**
 * Shared types for API route modules.
 *
 * Each module exports a createRoutes() function that receives ApiContext
 * and returns an array of Route entries. src/index.ts collects and mounts them.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Plugin, EventBus } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import type { TelemetryService } from "../telemetry/telemetry-service.ts";
import type { ContextMailbox } from "../../lib/dm/context-mailbox.ts";
import type { TaskTracker } from "../executor/task-tracker.ts";
import type { AgentKeyRegistry } from "../../lib/auth/agent-keys.ts";
import type { BusHistoryRecorder } from "../event-bus/history-recorder.ts";
import type { SkillResponseCache } from "../event-bus/skill-response-cache.ts";
import type { ChannelRegistry } from "../../lib/channels/channel-registry.ts";
import type { ProjectRegistry } from "../plugins/project-registry.ts";

export type Params = Record<string, string>;
export type RouteHandler = (req: Request, params: Params) => Response | Promise<Response>;

export interface Route {
  method: string;
  path: string;
  handler: RouteHandler;
}

/**
 * Shared context passed to every route module's createRoutes() function.
 * Add new dependencies here — not as globals in index.ts.
 */
export interface ApiContext {
  workspaceDir: string;
  /** Persistent storage root — where SQLite dbs live (knowledge.db, push-notifications.db, …). */
  dataDir?: string;
  bus: EventBus;
  plugins: Plugin[];
  executorRegistry: ExecutorRegistry;
  telemetry?: TelemetryService;
  apiKey?: string;
  /**
   * Per-agent API key registry — resolves request `X-API-Key` headers to a
   * CallerIdentity. When unset, endpoints fall back to the legacy single-key
   * model (admin-only via ctx.apiKey).
   */
  agentKeys?: AgentKeyRegistry;
  mailbox?: ContextMailbox;
  taskTracker?: TaskTracker;
  /**
   * Optional in-memory ring buffer of recent bus messages. Backs
   * /api/bus/history (D1 skill-trace view). Wired in src/index.ts only
   * when the bus-history-recorder plugin is installed.
   */
  busHistory?: BusHistoryRecorder;
  /**
   * Terminal skill-response cache keyed by correlationId. Backs
   * GET /api/a2a/task/:correlationId so a caller that stopped awaiting a
   * dispatch can still fetch the final outcome — covers both in-process
   * (dispatcher inline) and A2A (TaskTracker) results. Wired in src/index.ts.
   */
  skillResponseCache?: SkillResponseCache;
  /** Source of truth for project metadata (slug, path, github coordinates). */
  projectRegistry?: ProjectRegistry;
  /** Channels registry — used by routes that need per-project channel lookups. */
  channelRegistry?: ChannelRegistry;
}

/** Match a path against a pattern like "/api/foo/:id/run". Returns params or null. */
export function matchPath(pattern: string, path: string): Params | null {
  const pp = pattern.split("/");
  const sp = path.split("/");
  if (pp.length !== sp.length) return null;
  const params: Params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) {
      params[pp[i].slice(1)] = sp[i];
    } else if (pp[i] !== sp[i]) {
      return null;
    }
  }
  return params;
}

/** Serve a workspace YAML file's top-level key as JSON. */
export function serveWorkspaceYaml(workspaceDir: string, filename: string, key: string): Response {
  const filePath = join(workspaceDir, filename);
  if (!existsSync(filePath)) return Response.json({ success: true, data: [] });
  try {
    const parsed = parseYaml(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return Response.json({ success: true, data: parsed[key] ?? [] });
  } catch {
    return Response.json({ success: false, error: `Failed to parse ${filename}` }, { status: 500 });
  }
}

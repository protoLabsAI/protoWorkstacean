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
  bus: EventBus;
  plugins: Plugin[];
  executorRegistry: ExecutorRegistry;
  telemetry?: TelemetryService;
  apiKey?: string;
  mailbox?: ContextMailbox;
  taskTracker?: TaskTracker;
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

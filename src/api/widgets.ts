/**
 * Widget discovery endpoint — GET /api/widgets
 *
 * Aggregates WidgetDescriptor entries from every plugin that implements
 * getWidgets(). Plugins without getWidgets() are silently skipped.
 *
 * Response is cached with a 5-second TTL since plugins are static per runtime.
 * Requires X-API-Key header when ctx.apiKey is configured.
 */

import type { Route, ApiContext } from "./types.ts";
import type { WidgetDescriptor } from "../../lib/types.ts";

interface CacheEntry {
  widgets: WidgetDescriptor[];
  expiresAt: number;
}

const CACHE_TTL_MS = 5_000;

export function createRoutes(ctx: ApiContext): Route[] {
  let cache: CacheEntry | null = null;

  return [
    {
      method: "GET",
      path: "/api/widgets",
      handler: (req) => {
        if (ctx.apiKey && req.headers.get("X-API-Key") !== ctx.apiKey) {
          return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }

        const now = Date.now();
        if (!cache || now >= cache.expiresAt) {
          const widgets: WidgetDescriptor[] = [];
          for (const plugin of ctx.plugins) {
            if (typeof plugin.getWidgets === "function") {
              // Stamp pluginName from plugin.name so plugins don't have to
              // duplicate their own name on every widget descriptor.
              for (const w of plugin.getWidgets()) {
                widgets.push({ ...w, pluginName: plugin.name });
              }
            }
          }
          cache = { widgets, expiresAt: now + CACHE_TTL_MS };
        }

        return Response.json(cache.widgets, {
          headers: { "cache-control": `public, max-age=${CACHE_TTL_MS / 1000}` },
        });
      },
    },
  ];
}

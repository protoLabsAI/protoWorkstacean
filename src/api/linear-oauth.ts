/**
 * Linear Ava-agent OAuth routes — capture + expose the actor=app token so Ava
 * can post AS Ava (not as the operator's personal key). Piece A of the agent
 * identity work.
 *
 *   GET /api/linear/oauth/start     → 302 to Linear's authorize URL (admin)
 *   GET /api/linear/oauth/callback  → exchange code → store refresh token (public;
 *                                     CSRF-protected by the `state` param)
 *   GET /api/linear/oauth/status    → { configured, authorized, expiresAt } (admin)
 *
 * The callback is public by necessity (Linear calls it, no API key) — its
 * protection is the one-time `code` + the `state` check in the token manager.
 * `start` + `status` are admin-gated.
 */

import type { Route, ApiContext } from "./types.ts";
import { getLinearAvaTokenManager } from "../../lib/linear/ava-oauth-token-manager.ts";
import { logger } from "../../lib/log.ts";

const log = logger("linear-ava-oauth");

function htmlPage(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">` +
      `<h1>${title}</h1>${body}</body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export function createRoutes(ctx: ApiContext): Route[] {
  // Admin gate mirrors the operations.ts model: open when no apiKey configured;
  // otherwise require the admin key via header or ?apiKey= (browser-friendly).
  function isAdmin(req: Request): boolean {
    if (!ctx.apiKey) return true;
    const url = new URL(req.url);
    const headerKey = req.headers.get("X-API-Key");
    const bearer = req.headers.get("Authorization");
    const queryKey = url.searchParams.get("apiKey");
    const key = headerKey ?? (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null) ?? queryKey;
    return key === ctx.apiKey;
  }

  const dataDir = ctx.dataDir ?? "./data";

  return [
    {
      method: "GET",
      path: "/api/linear/oauth/start",
      handler: (req) => {
        if (!isAdmin(req)) {
          return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }
        const mgr = getLinearAvaTokenManager(dataDir);
        if (!mgr.isConfigured()) {
          return Response.json(
            { success: false, error: "Linear Ava OAuth not configured — set LINEAR_AVA_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI." },
            { status: 503 },
          );
        }
        const authorizeUrl = mgr.startAuthorization();
        // 302 so the operator can hit this URL directly in a browser and land
        // on Linear's consent screen.
        return new Response(null, { status: 302, headers: { Location: authorizeUrl } });
      },
    },
    {
      method: "GET",
      path: "/api/linear/oauth/callback",
      handler: async (req) => {
        const url = new URL(req.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        if (error) {
          return htmlPage("Linear authorization failed", `<p>Linear returned an error: <code>${error}</code>. Re-run <code>/api/linear/oauth/start</code>.</p>`, 400);
        }
        if (!code) {
          return htmlPage("Missing authorization code", `<p>No <code>code</code> in the callback. Start the flow at <code>/api/linear/oauth/start</code>.</p>`, 400);
        }
        const mgr = getLinearAvaTokenManager(dataDir);
        try {
          await mgr.handleCallback(code, state);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("callback failed", { err });
          return htmlPage("Authorization failed", `<p>${msg}</p>`, 400);
        }
        log.info("authorized — refresh token captured; Ava can now post as herself.");
        return htmlPage(
          "Ava is connected to Linear ✅",
          `<p>The agent token was captured and stored. Ava will now post as herself in Linear. You can close this tab.</p>`,
          200,
        );
      },
    },
    {
      method: "GET",
      path: "/api/linear/oauth/status",
      handler: (req) => {
        if (!isAdmin(req)) {
          return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }
        const mgr = getLinearAvaTokenManager(dataDir);
        return Response.json({ success: true, data: mgr.status() });
      },
    },
  ];
}

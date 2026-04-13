/**
 * Centralised environment configuration.
 *
 * All environment variables recognised by protoWorkstacean are declared here.
 *
 * Design — lazy parse, no module-load side effects:
 *   - Importing this module never throws and never calls process.exit().
 *   - Call `parseEnv()` explicitly at app boot to get fail-fast validation.
 *   - The `CONFIG` export is a live Proxy that always reflects the current
 *     value of `process.env`, so test-time overrides are visible immediately.
 *
 * Usage:
 *   // App entry point (src/index.ts):
 *   import { parseEnv, CONFIG } from "./config/env.ts";
 *   parseEnv(); // fail-fast validation at startup
 *
 *   // Any other module:
 *   import { CONFIG } from "../config/env.ts";
 *   const token = CONFIG.DISCORD_BOT_TOKEN;
 *
 * Never read process.env directly outside this file.
 */

import { z } from "zod";

// ── Schema ────────────────────────────────────────────────────────────────────
// All vars are optional strings — the system degrades gracefully when optional
// integrations are unconfigured. Add .min(1) to make a var required at boot.

export const EnvSchema = z
  .object({
    // Core runtime
    WORKSPACE_DIR:          z.string().optional(),
    DATA_DIR:               z.string().optional(),
    WORKSTACEAN_HTTP_PORT:  z.string().optional(),
    WORKSTACEAN_API_KEY:    z.string().optional(),
    WORKSTACEAN_PUBLIC_URL: z.string().optional(),
    WORKSTACEAN_URL:        z.string().optional(),
    ENABLED_PLUGINS:        z.string().optional(),
    DISABLE_EVENT_VIEWER:   z.string().optional(),
    /** Used by EventViewerPlugin when it manages its own port. */
    PORT:                   z.string().optional(),
    /** Timezone for cron schedule evaluation. */
    TZ:                     z.string().optional(),
    /** Set to "1" or "true" for verbose debug logging. */
    DEBUG:                  z.string().optional(),

    // Discord
    DISCORD_BOT_TOKEN:            z.string().optional(),
    DISCORD_GUILD_ID:             z.string().optional(),
    DISCORD_WELCOME_CHANNEL:      z.string().optional(),
    DISCORD_DIGEST_CHANNEL:       z.string().optional(),
    DISCORD_GOALS_WEBHOOK_URL:    z.string().optional(),
    DISCORD_CEREMONY_WEBHOOK_URL: z.string().optional(),
    DISCORD_BUDGET_WEBHOOK_URL:   z.string().optional(),
    DISCORD_OPS_WEBHOOK_URL:      z.string().optional(),
    /** General-purpose alert webhook (world-engine-alert, fallback). */
    DISCORD_WEBHOOK_ALERTS:       z.string().optional(),
    /** Idle timeout (ms) before a DM conversation session expires (default: 15 min). */
    DM_CONVERSATION_TIMEOUT_MS:   z.string().optional(),
    /** Sliding-window debounce (ms) for batching rapid-fire DMs (default: 3000). */
    DM_DEBOUNCE_MS:               z.string().optional(),
    /** TTL (ms) for pending mailbox messages before they're swept (default: 10 min). */
    MAILBOX_TTL_MS:               z.string().optional(),

    // GitHub
    GITHUB_TOKEN:          z.string().optional(),
    /** Legacy alias — prefer QUINN_APP_ID. */
    GITHUB_APP_ID:         z.string().optional(),
    QUINN_APP_ID:          z.string().optional(),
    QUINN_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_WEBHOOK_SECRET: z.string().optional(),
    GITHUB_WEBHOOK_PORT:   z.string().optional(),

    // Plane
    PLANE_API_KEY:        z.string().optional(),
    PLANE_BASE_URL:       z.string().optional(),
    PLANE_WORKSPACE_SLUG: z.string().optional(),
    PLANE_WEBHOOK_SECRET: z.string().optional(),
    PLANE_WEBHOOK_PORT:   z.string().optional(),

    // LLM gateway
    LLM_GATEWAY_URL:   z.string().optional(),
    OPENAI_API_KEY:    z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),

    // Langfuse observability
    LANGFUSE_PUBLIC_KEY: z.string().optional(),
    LANGFUSE_SECRET_KEY: z.string().optional(),
    /** Primary Langfuse host — used by LangfuseLogger and ConversationTracer. */
    LANGFUSE_HOST:       z.string().optional(),
    /** Alternative alias for LANGFUSE_HOST (legacy). */
    LANGFUSE_BASE_URL:   z.string().optional(),

    // Graphiti memory
    GRAPHITI_URL: z.string().optional(),

    // Vector memory
    QDRANT_URL:         z.string().optional(),
    QDRANT_VECTOR_SIZE: z.string().optional(),
    OLLAMA_URL:         z.string().optional(),
    OLLAMA_EMBED_MODEL: z.string().optional(),
    REDIS_URL:          z.string().optional(),

    // Router
    ROUTER_DEFAULT_SKILL:    z.string().optional(),
    ROUTER_DM_DEFAULT_AGENT: z.string().optional(),
    ROUTER_DM_DEFAULT_SKILL: z.string().optional(),
    DISABLE_ROUTER:          z.string().optional(),

    // AVA / A2A
    AVA_BASE_URL: z.string().optional(),
    AVA_API_KEY:  z.string().optional(),

    // Google Workspace
    GOOGLE_CLIENT_ID:     z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REFRESH_TOKEN: z.string().optional(),

    // Signal
    SIGNAL_URL:    z.string().optional(),
    SIGNAL_NUMBER: z.string().optional(),

    // Operational flags
    PR_REMEDIATOR_AUTO_MERGE: z.string().optional(),
  })
  .strict();

export type Env = z.infer<typeof EnvSchema>;

// ── parseEnv ──────────────────────────────────────────────────────────────────

/**
 * Validates the provided environment object (defaults to `process.env`) against
 * `EnvSchema` and returns the typed result.
 *
 * This function is intentionally NOT called at module load so that test files
 * can import `CONFIG` and type definitions without triggering validation.
 * Call it explicitly at app boot (e.g. in `src/index.ts`) for fail-fast behaviour.
 *
 * @param raw  Source to validate. Defaults to `process.env`.
 */
export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  // Extract only schema-known keys before passing to .strict().
  // This prevents system env vars (PATH, HOME, etc.) from failing the check.
  const knownKeys = Object.keys(EnvSchema.shape) as Array<keyof Env>;
  const envSubset = Object.fromEntries(knownKeys.map((k) => [k, raw[k]]));

  const result = EnvSchema.safeParse(envSubset);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(
      `[env] Invalid environment configuration — fix the following and restart:\n${issues}`,
    );
    process.exit(1);
  }
  return result.data;
}

// ── CONFIG ────────────────────────────────────────────────────────────────────

/**
 * Live proxy over `process.env`.
 *
 * Each property access reads from `process.env` at call time, so values set
 * after module load (e.g. in test `beforeEach` hooks) are always reflected.
 * No validation is performed on access — call `parseEnv()` at boot to validate.
 */
export const CONFIG = new Proxy({} as Env, {
  get(_target, key: string) {
    return process.env[key];
  },
}) as Readonly<Env>;

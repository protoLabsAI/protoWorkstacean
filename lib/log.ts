/**
 * Thin structured logger (#800 part 2).
 *
 * Replaces ad-hoc `console.*` with leveled, optionally-JSON output carrying a
 * component tag + structured fields (incl. correlationId), so prod logs can be
 * filtered by level and aggregated/queried by field instead of grepping free
 * text. Zero dependency.
 *
 * - `LOG_LEVEL` (debug|info|warn|error, default info) gates output.
 * - `LOG_FORMAT=json` (or `NODE_ENV=production`) → one JSON object per line;
 *   otherwise a readable `LEVEL [component] message {fields}` dev line.
 *
 * Usage:
 *   const log = logger("a2a-server");
 *   log.info("dispatched", { correlationId, skill });
 *   log.error("publish failed", { topic, err });
 *
 * Migration is incremental — `console.*` still works; new/edited code should
 * prefer this. The bulk sweep is tracked separately.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = (env.LOG_LEVEL ?? "info").toLowerCase();
  return raw in ORDER ? (raw as LogLevel) : "info";
}
function useJson(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOG_FORMAT === "json" || env.NODE_ENV === "production";
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Child logger with bound fields merged into every line (e.g. correlationId). */
  child(bound: Record<string, unknown>): Logger;
}

function normalizeFields(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { message: v.message, stack: v.stack } : v;
  }
  return out;
}

function emit(component: string, level: LogLevel, msg: string, bound: Record<string, unknown>, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[configuredLevel()]) return;
  const merged = { ...bound, ...normalizeFields(fields) };
  const hasFields = Object.keys(merged).length > 0;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (useJson()) {
    sink(JSON.stringify({ level, component, msg, ...merged, ts: new Date().toISOString() }));
  } else {
    sink(`${level.toUpperCase()} [${component}] ${msg}${hasFields ? " " + JSON.stringify(merged) : ""}`);
  }
}

export function logger(component: string, bound: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, f) => emit(component, "debug", m, bound, f),
    info: (m, f) => emit(component, "info", m, bound, f),
    warn: (m, f) => emit(component, "warn", m, bound, f),
    error: (m, f) => emit(component, "error", m, bound, f),
    child: (extra) => logger(component, { ...bound, ...extra }),
  };
}

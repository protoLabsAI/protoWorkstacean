import { logger } from "../../lib/log.ts";

const log = logger("env-interpolation");

/**
 * Interpolate ${ENV_VAR} placeholders in a string.
 * Unresolved variables are left as-is and a warning is emitted.
 */
export function resolveEnvVars(str: string, context?: string): string {
  return str.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    const val = process.env[name];
    if (val === undefined) {
      log.warn(`Unresolved env var: \${${name}}`, { context: context ?? "env" });
      return match;
    }
    return val;
  });
}

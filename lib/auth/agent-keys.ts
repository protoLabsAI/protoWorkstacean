/**
 * Per-agent API key resolver — backs the multi-tenant cron / ceremony
 * scoping and any future operator-vs-agent permission gates.
 *
 * Two key tiers exist on workstacean:
 *
 *   - **admin**: the legacy `WORKSTACEAN_API_KEY` env var. Holds full
 *     read/write across all resources; used by Ava (in-process), the
 *     dashboard, and out-of-band operator scripts. Backward-compatible
 *     with every endpoint that already calls `ctx.apiKey === <header>`.
 *
 *   - **agent-scoped**: per-agent keys declared in
 *     `workspace/agent-keys.yaml` (env-resolved). Each entry binds a
 *     friendly `agentName` to an env var holding the secret. Used by
 *     external A2A agents (Quinn, Jon, Researcher, protopen) and by any
 *     in-process agent that wants to be subject to ownership checks.
 *
 * The resolver returns `{ agentName?, isAdmin }`. `agentName` is only
 * set for agent-scoped keys; admin callers are agentless and bypass all
 * ownership checks.
 *
 * Yaml shape:
 *
 *   keys:
 *     quinn:
 *       envKey: WORKSTACEAN_API_KEY_QUINN
 *     jon:
 *       envKey: WORKSTACEAN_API_KEY_JON
 *     researcher:
 *       envKey: WORKSTACEAN_API_KEY_RESEARCHER
 *
 * Missing file or unset env vars are treated as absent — the resolver
 * falls back to admin-only auth (current behavior). This means rolling
 * out per-agent keys is incremental: deploy the yaml, set env vars per
 * agent at your own pace.
 */

import { existsSync, readFileSync, watchFile } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface CallerIdentity {
  /** Set when the request was authenticated via an agent-scoped key. */
  agentName?: string;
  /** True for the legacy WORKSTACEAN_API_KEY (operator / Ava / dashboard). */
  isAdmin: boolean;
}

interface AgentKeyEntry {
  envKey: string;
}

interface AgentKeysFile {
  keys?: Record<string, AgentKeyEntry>;
}

export class AgentKeyRegistry {
  /** Map of API-key value → agent name. Rebuilt on yaml change. */
  private keyToAgent = new Map<string, string>();
  private adminKey: string | undefined;
  private readonly yamlPath: string;

  constructor(workspaceDir: string, adminKey: string | undefined) {
    this.adminKey = adminKey;
    this.yamlPath = join(workspaceDir, "agent-keys.yaml");
    this.reload();
    if (existsSync(this.yamlPath)) {
      // Hot-reload — operator can rotate / add keys without restart.
      watchFile(this.yamlPath, { interval: 5_000 }, () => this.reload());
    }
  }

  /**
   * Resolve a request's `X-API-Key` header (or `Authorization: Bearer ...`)
   * to a CallerIdentity. Returns null when no key matches — caller decides
   * whether to 401 or fall through (e.g. `ctx.apiKey` not configured at all).
   */
  resolve(apiKey: string | null | undefined): CallerIdentity | null {
    if (!apiKey) return null;
    if (this.adminKey && apiKey === this.adminKey) {
      return { isAdmin: true };
    }
    const agentName = this.keyToAgent.get(apiKey);
    if (agentName) {
      return { agentName, isAdmin: false };
    }
    return null;
  }

  /** True if any per-agent keys are configured (used to gate strict mode). */
  get hasAgentKeys(): boolean {
    return this.keyToAgent.size > 0;
  }

  /** All known agent names (for diagnostics + dashboard). */
  agentNames(): string[] {
    return Array.from(new Set(this.keyToAgent.values()));
  }

  private reload(): void {
    const next = new Map<string, string>();
    if (!existsSync(this.yamlPath)) {
      this.keyToAgent = next;
      return;
    }
    try {
      const parsed = parseYaml(readFileSync(this.yamlPath, "utf8")) as AgentKeysFile;
      for (const [agentName, entry] of Object.entries(parsed.keys ?? {})) {
        if (!entry?.envKey) continue;
        const value = process.env[entry.envKey];
        if (!value) {
          console.warn(
            `[agent-keys] ${agentName}: env var "${entry.envKey}" is unset — skipping`,
          );
          continue;
        }
        if (next.has(value)) {
          console.warn(
            `[agent-keys] duplicate key value detected — multiple agents share the same secret. Last write wins.`,
          );
        }
        next.set(value, agentName);
      }
      this.keyToAgent = next;
      if (next.size > 0) {
        console.log(
          `[agent-keys] Loaded ${next.size} per-agent key(s): ${this.agentNames().join(", ")}`,
        );
      }
    } catch (err) {
      console.error(`[agent-keys] Failed to parse ${this.yamlPath}:`, err);
    }
  }
}

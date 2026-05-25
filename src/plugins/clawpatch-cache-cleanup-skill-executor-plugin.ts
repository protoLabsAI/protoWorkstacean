/**
 * ClawpatchCacheCleanupSkillExecutorPlugin — registers a FunctionExecutor
 * for the `ceremony.clawpatch_cache_cleanup` skill that drives the daily
 * `clawpatch.cache_cleanup` ceremony (workspace/ceremonies/clawpatch-cache-cleanup.yaml).
 *
 * Pure janitor — no agent involved. Calls `CheckoutCache.prune()` directly
 * to drop TTL-stale entries and LRU-evict the cache back under its caps.
 * Lives outside the request path so reviews never pay the prune IO cost.
 *
 * Install order: must run AFTER ExecutorRegistry construction and BEFORE
 * SkillDispatcherPlugin (same constraint as alert-skill-executor).
 */

import type { Plugin, EventBus } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import type { SkillRequest, SkillResult } from "../executor/types.ts";
import { FunctionExecutor } from "../executor/executors/function-executor.ts";
import { CheckoutCache } from "../../lib/checkout-cache.ts";
import { makeGitHubAuth } from "../../lib/github-auth.ts";

export class ClawpatchCacheCleanupSkillExecutorPlugin implements Plugin {
  readonly name = "clawpatch-cache-cleanup-skill-executor";
  readonly description =
    "Registers the FunctionExecutor that prunes the clawpatch checkout cache";
  readonly capabilities = ["cache-prune", "executor-registrar"];

  private _cache: CheckoutCache | null = null;

  constructor(
    private readonly registry: ExecutorRegistry,
    /**
     * Optional cache override for tests. Production passes nothing and the
     * plugin lazily builds a default-config CheckoutCache the first time
     * the ceremony fires.
     */
    private readonly cacheOverride?: CheckoutCache,
  ) {}

  install(_bus: EventBus): void {
    this._cache = this.cacheOverride ?? new CheckoutCache({
      getToken: makeGitHubAuth() ?? undefined,
    });
    const executor = new FunctionExecutor(async (req) => this._execute(req));
    this.registry.register("ceremony.clawpatch_cache_cleanup", executor, { priority: 5 });
    console.log(
      "[clawpatch-cache-cleanup-skill-executor] Registered ceremony.clawpatch_cache_cleanup",
    );
  }

  uninstall(): void {
    this._cache = null;
  }

  private async _execute(req: SkillRequest): Promise<SkillResult> {
    if (!this._cache) {
      return {
        text: "plugin not installed",
        isError: true,
        correlationId: req.correlationId,
      };
    }
    const startedAt = Date.now();
    try {
      const { evicted, bytesFreed } = await this._cache.prune();
      const durationMs = Date.now() - startedAt;
      console.log(
        `[clawpatch-cache-cleanup] pruned ${evicted} entr${evicted === 1 ? "y" : "ies"} ` +
          `(${bytesFreed} bytes) in ${durationMs}ms`,
      );
      return {
        text: `clawpatch checkout cache: evicted=${evicted} bytesFreed=${bytesFreed} durationMs=${durationMs}`,
        isError: false,
        correlationId: req.correlationId,
        data: { durationMs, success: true },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        text: `clawpatch cache prune failed: ${msg}`,
        isError: true,
        correlationId: req.correlationId,
      };
    }
  }
}

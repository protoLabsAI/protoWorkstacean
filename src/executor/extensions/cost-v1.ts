/**
 * x-protolabscost-v1 extension — records per-skill cost actuals and maintains
 * running averages that converge on real observed behaviour over time.
 *
 * Agent cards declare per-skill estimates in their extension params:
 *
 *   capabilities.extensions:
 *     - uri: https://protolabs.ai/a2a/ext/cost-v1
 *       params:
 *         skills:
 *           deep_research:
 *             avgTokensIn: 2000
 *             avgTokensOut: 8000
 *             avgWallMs: 300000
 *
 * The interceptor:
 *   before(ctx): stamps the registered estimate onto outbound metadata so the
 *     remote agent can see its expected cost budget for this call.
 *
 *   after(ctx, result): reads actual token usage from the result, computes wall
 *     time, updates the in-memory running averages (exponential moving average),
 *     and publishes an `autonomous.cost.<agentName>` event.
 *
 * Call `registerCostV1Extension(bus)` once at startup (e.g. in src/index.ts).
 * The returned object exposes `registerEstimate()` so callers (e.g.
 * SkillBrokerPlugin reading agent cards) can seed initial estimates.
 *
 * Extension URI: https://protolabs.ai/a2a/ext/cost-v1
 */

import type { EventBus } from "../../../lib/types.ts";
import {
  defaultExtensionRegistry,
  type ExtensionInterceptor,
  type ExtensionContext,
} from "../extension-registry.ts";

export const COST_V1_URI = "https://protolabs.ai/a2a/ext/cost-v1";

/** Per-skill cost estimate declared in an agent card extension params block. */
export interface SkillCostEstimate {
  /** Average input tokens for this skill (prompt + context). */
  avgTokensIn: number;
  /** Average output tokens for this skill. */
  avgTokensOut: number;
  /** Average wall-clock milliseconds for this skill to complete. */
  avgWallMs: number;
}

/** In-memory running statistics per agent+skill pair. */
export interface SkillCostStats {
  /** Number of executions observed so far. */
  count: number;
  /** Exponential moving average of input tokens. */
  avgTokensIn: number;
  /** Exponential moving average of output tokens. */
  avgTokensOut: number;
  /** Exponential moving average of wall-clock ms. */
  avgWallMs: number;
}

/**
 * Payload published on `autonomous.cost.<agentName>` after each skill execution
 * that is covered by the cost-v1 extension.
 */
export interface CostActualPayload {
  /** Agent that executed the skill. */
  source: string;
  /** Skill that was executed. */
  skill: string;
  /** Trace ID from the originating request. */
  correlationId: string;
  /** Estimate declared in the agent card (0 if none registered). */
  estimatedTokensIn: number;
  estimatedTokensOut: number;
  estimatedWallMs: number;
  /** Actual input tokens reported in the response (undefined if not available). */
  actualTokensIn: number | undefined;
  /** Actual output tokens reported in the response (undefined if not available). */
  actualTokensOut: number | undefined;
  /** Measured wall-clock ms from before() to after(). */
  actualWallMs: number;
  /** Updated running average input tokens after incorporating this sample. */
  runningAvgTokensIn: number;
  /** Updated running average output tokens after incorporating this sample. */
  runningAvgTokensOut: number;
  /** Updated running average wall ms after incorporating this sample. */
  runningAvgWallMs: number;
  /** Total number of observed executions for this agent+skill pair. */
  sampleCount: number;
}

/**
 * Smoothing factor for the exponential moving average.
 * alpha=0.2 gives reasonable responsiveness while filtering short-term noise.
 */
const EMA_ALPHA = 0.2;

function ema(current: number, sample: number, count: number): number {
  // First sample: initialise to the sample itself.
  if (count === 1) return sample;
  return current * (1 - EMA_ALPHA) + sample * EMA_ALPHA;
}

/**
 * Creates and registers the cost-v1 interceptor with `defaultExtensionRegistry`.
 *
 * Returns a handle with `registerEstimate()` so callers can seed per-skill
 * estimates read from agent cards.
 *
 * Must be called once at startup with a live EventBus reference so the `after`
 * hook can publish `autonomous.cost.<agentName>`.
 */
export function registerCostV1Extension(bus: EventBus): {
  /** Register the declared cost estimate for an agent+skill pair. */
  registerEstimate(agentName: string, skill: string, estimate: SkillCostEstimate): void;
  /** Read the current running stats for an agent+skill pair (for diagnostics). */
  getStats(agentName: string, skill: string): SkillCostStats | undefined;
} {
  // key: `${agentName}:${skill}`
  const estimates = new Map<string, SkillCostEstimate>();
  const stats = new Map<string, SkillCostStats>();
  // key: correlationId — wall-clock start time recorded in before()
  const startTimes = new Map<string, number>();

  const interceptor: ExtensionInterceptor = {
    before(ctx: ExtensionContext): void {
      startTimes.set(ctx.correlationId, Date.now());

      const key = `${ctx.agentName}:${ctx.skill}`;
      const estimate = estimates.get(key);
      if (estimate) {
        ctx.metadata["x-cost-v1-estimated-tokens-in"] = estimate.avgTokensIn;
        ctx.metadata["x-cost-v1-estimated-tokens-out"] = estimate.avgTokensOut;
        ctx.metadata["x-cost-v1-estimated-wall-ms"] = estimate.avgWallMs;
      }
    },

    after(
      ctx: ExtensionContext,
      result: { text: string; data?: Record<string, unknown> },
    ): void {
      const startedAt = startTimes.get(ctx.correlationId) ?? Date.now();
      startTimes.delete(ctx.correlationId);
      const actualWallMs = Date.now() - startedAt;

      const key = `${ctx.agentName}:${ctx.skill}`;
      const estimate = estimates.get(key) ?? {
        avgTokensIn: 0,
        avgTokensOut: 0,
        avgWallMs: 0,
      };

      // Extract actual token usage from the result. The SDK surfaces token
      // counts in result.data.usage (typed as ExtendedUsage in SkillResult).
      const usage = result.data?.usage as
        | { input_tokens?: number; output_tokens?: number }
        | undefined;
      const actualTokensIn = usage?.input_tokens;
      const actualTokensOut = usage?.output_tokens;

      // Update running averages using EMA.
      const prev = stats.get(key) ?? {
        count: 0,
        avgTokensIn: 0,
        avgTokensOut: 0,
        avgWallMs: 0,
      };
      const count = prev.count + 1;
      const updated: SkillCostStats = {
        count,
        avgTokensIn:
          actualTokensIn != null
            ? ema(prev.avgTokensIn, actualTokensIn, count)
            : prev.avgTokensIn,
        avgTokensOut:
          actualTokensOut != null
            ? ema(prev.avgTokensOut, actualTokensOut, count)
            : prev.avgTokensOut,
        avgWallMs: ema(prev.avgWallMs, actualWallMs, count),
      };
      stats.set(key, updated);

      const topic = `autonomous.cost.${ctx.agentName}`;
      bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: ctx.correlationId,
        topic,
        timestamp: Date.now(),
        payload: {
          source: ctx.agentName,
          skill: ctx.skill,
          correlationId: ctx.correlationId,
          estimatedTokensIn: estimate.avgTokensIn,
          estimatedTokensOut: estimate.avgTokensOut,
          estimatedWallMs: estimate.avgWallMs,
          actualTokensIn,
          actualTokensOut,
          actualWallMs,
          runningAvgTokensIn: updated.avgTokensIn,
          runningAvgTokensOut: updated.avgTokensOut,
          runningAvgWallMs: updated.avgWallMs,
          sampleCount: updated.count,
        } satisfies CostActualPayload,
      });
    },
  };

  defaultExtensionRegistry.register({
    uri: COST_V1_URI,
    interceptor,
    description:
      "Cost v1: stamps per-skill cost estimates on outbound metadata and publishes autonomous.cost.# actuals after execution",
  });

  return {
    registerEstimate(agentName: string, skill: string, estimate: SkillCostEstimate): void {
      estimates.set(`${agentName}:${skill}`, estimate);
    },
    getStats(agentName: string, skill: string): SkillCostStats | undefined {
      return stats.get(`${agentName}:${skill}`);
    },
  };
}

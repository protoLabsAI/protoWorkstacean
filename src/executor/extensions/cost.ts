/**
 * Cost v1 extension — tracks token + wall-time cost per (agent, skill) pair.
 *
 * Agents advertise per-skill cost estimates in their agent card under the
 * `cost-v1` extension. The interceptor records actuals from each completed
 * task so the planner can rank candidates by cost/confidence/blast tiebreak
 * (Arc 6.4) and the dashboard can surface a fleet cost-per-outcome view
 * (Arc 6.5).
 *
 *   before(ctx): stamps `x-protolabs-cost-estimate` onto outbound metadata
 *     if the agent advertised estimates — gives the agent a chance to cap
 *     its own spend.
 *
 *   after(ctx, result): reads `result.data.usage` (A2AExecutor / ProtoSdkExecutor
 *     both surface this) and appends a CostSample to the running stats store;
 *     publishes `autonomous.cost.{systemActor}.{skill}` for observability.
 *
 * Extension URI: https://protolabs.ai/a2a/ext/cost-v1
 */

import type { EventBus } from "../../../lib/types.ts";
import {
  defaultExtensionRegistry,
  type ExtensionInterceptor,
  type ExtensionContext,
} from "../extension-registry.ts";

export const COST_URI = "https://protolabs.ai/a2a/ext/cost-v1";

/**
 * Per-skill cost estimate as declared by the agent card.
 * Values are rolling averages the agent reports — not strict caps.
 */
export interface CostEstimate {
  /** Average input tokens per call. */
  avgTokensIn?: number;
  /** Average output tokens per call. */
  avgTokensOut?: number;
  /** Average wall-clock time per call, in milliseconds. */
  avgWallMs?: number;
  /** Optional dollar-cost estimate (provider-dependent). */
  avgCostUsd?: number;
}

/**
 * Observed actuals from a single completed task.
 */
export interface CostSample {
  /** Who issued this task ("goap", "ceremony:{id}", "user", …). */
  systemActor: string;
  /** Agent that executed the task. */
  agentName: string;
  /** Skill name. */
  skill: string;
  /** Actuals pulled from executor result.data.usage + duration. */
  tokensIn?: number;
  tokensOut?: number;
  wallMs: number;
  /** Estimated dollar cost when the executor reported it. */
  costUsd?: number;
  /** Task outcome. */
  success: boolean;
  /** Absolute timestamp (ms epoch) when the task completed. */
  completedAt: number;
  /** Correlates back to the originating bus message. */
  correlationId: string;
}

/**
 * Minimal rolling cost store. Keeps last N samples per (agent, skill)
 * key and exposes averages/percentiles for the planner's tiebreak logic
 * and the dashboard's fleet-cost view.
 *
 * Intentionally in-memory — this is observational telemetry, not billing.
 * A full persistence layer is a separate concern (Arc 6.5 dashboard).
 */
export class CostStore {
  private readonly samples = new Map<string, CostSample[]>();
  private readonly maxPerKey: number;

  constructor(maxPerKey = 200) {
    this.maxPerKey = maxPerKey;
  }

  static key(agentName: string, skill: string): string {
    return `${agentName}::${skill}`;
  }

  record(sample: CostSample): void {
    const k = CostStore.key(sample.agentName, sample.skill);
    const arr = this.samples.get(k) ?? [];
    arr.push(sample);
    if (arr.length > this.maxPerKey) arr.splice(0, arr.length - this.maxPerKey);
    this.samples.set(k, arr);
  }

  /** Average cost + success rate across recent samples for a single skill. */
  summary(agentName: string, skill: string): CostSummary | undefined {
    const arr = this.samples.get(CostStore.key(agentName, skill));
    if (!arr || arr.length === 0) return undefined;
    const n = arr.length;
    const sum = arr.reduce(
      (acc, s) => ({
        tokensIn: acc.tokensIn + (s.tokensIn ?? 0),
        tokensOut: acc.tokensOut + (s.tokensOut ?? 0),
        wallMs: acc.wallMs + s.wallMs,
        costUsd: acc.costUsd + (s.costUsd ?? 0),
        successes: acc.successes + (s.success ? 1 : 0),
      }),
      { tokensIn: 0, tokensOut: 0, wallMs: 0, costUsd: 0, successes: 0 },
    );
    return {
      agentName,
      skill,
      sampleCount: n,
      avgTokensIn: sum.tokensIn / n,
      avgTokensOut: sum.tokensOut / n,
      avgWallMs: sum.wallMs / n,
      avgCostUsd: sum.costUsd / n,
      successRate: sum.successes / n,
    };
  }

  /** All summaries — for the fleet dashboard view. */
  allSummaries(): CostSummary[] {
    return Array.from(this.samples.keys())
      .map(k => {
        const [agentName, skill] = k.split("::");
        return this.summary(agentName, skill);
      })
      .filter((s): s is CostSummary => !!s);
  }

  get size(): number {
    return this.samples.size;
  }
}

export interface CostSummary {
  agentName: string;
  skill: string;
  sampleCount: number;
  avgTokensIn: number;
  avgTokensOut: number;
  avgWallMs: number;
  avgCostUsd: number;
  successRate: number;
}

/** Default singleton store — matches the pattern of defaultExtensionRegistry. */
export const defaultCostStore = new CostStore();

/**
 * Creates and registers the cost interceptor with `defaultExtensionRegistry`.
 *
 * Must be called once at startup with a live EventBus reference so the `after`
 * hook can publish `autonomous.cost.*` observability events.
 */
export function registerCostExtension(
  bus: EventBus,
  store: CostStore = defaultCostStore,
): void {
  const interceptor: ExtensionInterceptor = {
    before(ctx: ExtensionContext): void {
      // Stamp the skill name onto outbound metadata — mirrors effect-domain-v1's
      // behavior so agents can correlate cost advertisements with invocations.
      ctx.metadata["x-cost-skill"] = ctx.skill;
    },

    after(
      ctx: ExtensionContext,
      result: { text: string; data?: Record<string, unknown> },
    ): void {
      const usage = (result.data?.usage ?? {}) as {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      const durationMs = typeof result.data?.durationMs === "number"
        ? (result.data.durationMs as number)
        : 0;
      const costUsd = typeof result.data?.costUsd === "number"
        ? (result.data.costUsd as number)
        : undefined;
      const success = result.data?.success !== false;
      const systemActor = typeof ctx.metadata["systemActor"] === "string"
        ? (ctx.metadata["systemActor"] as string)
        : "user";

      const sample: CostSample = {
        systemActor,
        agentName: ctx.agentName,
        skill: ctx.skill,
        tokensIn: usage.input_tokens,
        tokensOut: usage.output_tokens,
        wallMs: durationMs,
        costUsd,
        success,
        completedAt: Date.now(),
        correlationId: ctx.correlationId,
      };

      store.record(sample);

      // Observability: publish a compact cost event. OutcomeAnalysis or a
      // dashboard collector can subscribe to autonomous.cost.# to produce
      // the fleet cost-per-outcome view (Arc 6.5).
      const topic = `autonomous.cost.${systemActor}.${ctx.skill}`;
      bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: ctx.correlationId,
        topic,
        timestamp: sample.completedAt,
        payload: sample,
      });
    },
  };

  defaultExtensionRegistry.register({
    uri: COST_URI,
    interceptor,
    description:
      "Cost v1: records per-(agent, skill) token+wall-time actuals, publishes autonomous.cost.* observability events",
  });
}

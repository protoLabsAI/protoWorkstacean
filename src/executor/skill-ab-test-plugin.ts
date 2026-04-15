/**
 * SkillAbTestPlugin — A/B test competing skill executor variants.
 *
 * When Ava (or any caller) proposes an alternative executor for an existing
 * skill, this plugin runs both variants in parallel for N total dispatches,
 * compares success rate and cost, and commits the winner back to the registry.
 *
 * Usage:
 *   const abTest = new SkillAbTestPlugin(executorRegistry);
 *   abTest.install(bus);
 *   abTest.registerTest("bug_triage", quinnV1Executor, quinnV2Executor, 20);
 *
 * Architecture:
 *   - Installs a resolve hook on ExecutorRegistry via setResolveHook().
 *   - For skills under test, the hook returns an AbTestExecutor wrapper.
 *   - AbTestExecutor uses correlationId hash to deterministically assign each
 *     dispatch to control (bucket 0) or challenger (bucket 1) — 50/50 split.
 *   - After n total dispatches, selectWinner() picks the arm with higher
 *     success rate; ties are broken by lower average token cost.
 *   - The winner's executor is registered at priority 100, removing the test.
 *   - Publishes skill.ab_test.resolved on completion.
 *
 * Bus topics:
 *   Inbound:  skill.ab_test.register  (programmatic via bus — see payload type)
 *   Outbound: skill.ab_test.resolved  (winner committed)
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { ExecutorRegistry } from "./executor-registry.ts";
import type { IExecutor, SkillRequest, SkillResult } from "./types.ts";

// ── Public types ──────────────────────────────────────────────────────────────

export interface AbTestMetrics {
  dispatches: number;
  successes: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface AbTestState {
  skill: string;
  /** Total dispatches (across both arms) before declaring a winner. */
  n: number;
  control: { executor: IExecutor; metrics: AbTestMetrics };
  challenger: { executor: IExecutor; metrics: AbTestMetrics };
  startedAt: number;
  resolvedAt?: number;
  winner?: "control" | "challenger";
}

/** Payload for skill.ab_test.resolved */
export interface AbTestResolvedPayload {
  skill: string;
  winner: "control" | "challenger";
  controlMetrics: AbTestMetrics;
  challengerMetrics: AbTestMetrics;
  resolvedAt: number;
  reason: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Deterministic 0/1 bucket from a correlationId string.
 * Same correlationId always maps to the same arm — retries stay consistent.
 */
function hashBucket(correlationId: string): 0 | 1 {
  let hash = 0;
  for (let i = 0; i < correlationId.length; i++) {
    hash = (((hash << 5) - hash) + correlationId.charCodeAt(i)) >>> 0;
  }
  return (hash % 2) as 0 | 1;
}

function successRate(m: AbTestMetrics): number {
  return m.dispatches === 0 ? 0 : m.successes / m.dispatches;
}

function avgTokensPerDispatch(m: AbTestMetrics): number {
  return m.dispatches === 0 ? 0 : (m.totalInputTokens + m.totalOutputTokens) / m.dispatches;
}

function selectWinner(state: AbTestState): "control" | "challenger" {
  const cRate = successRate(state.control.metrics);
  const chRate = successRate(state.challenger.metrics);

  // If challenger wins by more than 5 percentage points → challenger
  if (chRate > cRate + 0.05) return "challenger";
  // If control wins by more than 5 percentage points → control
  if (cRate > chRate + 0.05) return "control";

  // Tied on success rate — lower avg token cost wins
  const cCost = avgTokensPerDispatch(state.control.metrics);
  const chCost = avgTokensPerDispatch(state.challenger.metrics);
  return chCost < cCost ? "challenger" : "control";
}

function buildReason(winner: "control" | "challenger", state: AbTestState): string {
  const c = state.control.metrics;
  const ch = state.challenger.metrics;
  const cRate = successRate(c);
  const chRate = successRate(ch);

  if (Math.abs(cRate - chRate) > 0.05) {
    return (
      `${winner} had higher success rate ` +
      `(control=${(cRate * 100).toFixed(0)}% challenger=${(chRate * 100).toFixed(0)}%)`
    );
  }

  const cCost = avgTokensPerDispatch(c);
  const chCost = avgTokensPerDispatch(ch);
  return (
    `tied on success rate; ${winner} had lower avg cost ` +
    `(control=${cCost.toFixed(0)} challenger=${chCost.toFixed(0)} tokens/dispatch)`
  );
}

function emptyMetrics(): AbTestMetrics {
  return { dispatches: 0, successes: 0, totalInputTokens: 0, totalOutputTokens: 0 };
}

// ── AbTestExecutor ────────────────────────────────────────────────────────────

/**
 * Wraps two executors and routes each dispatch to control or challenger
 * based on a deterministic correlationId hash. Tracks per-arm metrics
 * and fires onWinner() once the dispatch budget is exhausted.
 */
export class AbTestExecutor implements IExecutor {
  readonly type = "ab-test";

  constructor(
    private readonly state: AbTestState,
    private readonly onWinner: (winner: "control" | "challenger", state: AbTestState) => void,
  ) {}

  async execute(req: SkillRequest): Promise<SkillResult> {
    const bucket = hashBucket(req.correlationId);
    const arm = bucket === 0 ? "control" : "challenger";
    const { executor, metrics } = this.state[arm];

    const result = await executor.execute(req);

    metrics.dispatches++;
    if (!result.isError) metrics.successes++;
    if (result.data?.usage) {
      metrics.totalInputTokens += result.data.usage.input_tokens ?? 0;
      metrics.totalOutputTokens += result.data.usage.output_tokens ?? 0;
    }

    const total =
      this.state.control.metrics.dispatches + this.state.challenger.metrics.dispatches;

    if (total >= this.state.n && !this.state.resolvedAt) {
      const winner = selectWinner(this.state);
      this.onWinner(winner, this.state);
    }

    return result;
  }
}

// ── SkillAbTestPlugin ─────────────────────────────────────────────────────────

export class SkillAbTestPlugin implements Plugin {
  readonly name = "skill-ab-test";
  readonly description =
    "A/B tests competing skill executor variants; auto-commits winner after N dispatches.";
  readonly capabilities = ["ab_testing", "executor_routing"];

  private readonly tests = new Map<string, AbTestState>();
  private readonly abExecutors = new Map<string, AbTestExecutor>();
  private bus!: EventBus;
  private subscriptionId?: string;

  constructor(private readonly registry: ExecutorRegistry) {}

  install(bus: EventBus): void {
    this.bus = bus;

    // Install resolve hook — returns AbTestExecutor for skills under test
    this.registry.setResolveHook((skill, _targets, resolved) => {
      const abExec = this.abExecutors.get(skill);
      return abExec ?? resolved;
    });

    // Bus topic: accept programmatic test registrations (control/challenger
    // must already be registered in the ExecutorRegistry at call time)
    this.subscriptionId = bus.subscribe(
      "skill.ab_test.register",
      this.name,
      (msg: BusMessage) => this.handleRegisterMessage(msg),
    );
  }

  uninstall(): void {
    this.registry.setResolveHook(null);
    if (this.subscriptionId && this.bus) {
      this.bus.unsubscribe(this.subscriptionId);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start an A/B test for a skill.
   *
   * @param skill            Skill name to intercept (e.g. "bug_triage")
   * @param controlExecutor  Current/baseline executor
   * @param challengerExecutor  New executor to evaluate
   * @param n                Total dispatches before declaring a winner
   */
  registerTest(
    skill: string,
    controlExecutor: IExecutor,
    challengerExecutor: IExecutor,
    n: number,
  ): void {
    if (this.tests.has(skill)) {
      console.warn(
        `[skill-ab-test] Test for '${skill}' already in progress — ignoring duplicate registerTest()`,
      );
      return;
    }

    const state: AbTestState = {
      skill,
      n,
      control: { executor: controlExecutor, metrics: emptyMetrics() },
      challenger: { executor: challengerExecutor, metrics: emptyMetrics() },
      startedAt: Date.now(),
    };

    this.tests.set(skill, state);
    this.abExecutors.set(
      skill,
      new AbTestExecutor(state, (winner, s) => this.commitWinner(winner, s)),
    );

    console.info(
      `[skill-ab-test] Started test for '${skill}' ` +
      `(n=${n}, control=${controlExecutor.type}, challenger=${challengerExecutor.type})`,
    );
  }

  /** Current test state for a skill (includes metrics). undefined if no test active. */
  getTestStatus(skill: string): AbTestState | undefined {
    return this.tests.get(skill);
  }

  /** All tests (active and resolved). */
  listTests(): AbTestState[] {
    return [...this.tests.values()];
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private commitWinner(winner: "control" | "challenger", state: AbTestState): void {
    state.resolvedAt = Date.now();
    state.winner = winner;

    // Remove the ab-test executor first — future resolves bypass this plugin
    this.abExecutors.delete(state.skill);

    // Register winner at priority 100 so it wins over any existing registrations
    this.registry.register(state.skill, state[winner].executor, { priority: 100 });

    const reason = buildReason(winner, state);

    const payload: AbTestResolvedPayload = {
      skill: state.skill,
      winner,
      controlMetrics: state.control.metrics,
      challengerMetrics: state.challenger.metrics,
      resolvedAt: state.resolvedAt,
      reason,
    };

    this.bus.publish("skill.ab_test.resolved", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "skill.ab_test.resolved",
      timestamp: Date.now(),
      payload,
    });

    console.info(
      `[skill-ab-test] Test resolved for '${state.skill}': winner=${winner} (${reason})`,
    );
  }

  /**
   * Handle skill.ab_test.register bus messages.
   * Expects payload: { skill, n, controlType, challengerType }
   * where controlType and challengerType identify registered executor agentNames.
   *
   * For more control, callers should use registerTest() directly.
   */
  private handleRegisterMessage(msg: BusMessage): void {
    const p = msg.payload as {
      skill?: string;
      n?: number;
      controlAgentName?: string;
      challengerAgentName?: string;
    } | null;

    if (!p?.skill || typeof p.n !== "number") {
      console.warn(
        "[skill-ab-test] skill.ab_test.register message missing required fields (skill, n) — ignored",
      );
      return;
    }

    // Resolve executors from the registry by agent name
    const controlExec = p.controlAgentName
      ? this.registry.resolve(p.skill, [p.controlAgentName])
      : this.registry.resolve(p.skill);

    if (!controlExec) {
      console.warn(
        `[skill-ab-test] No control executor found for skill '${p.skill}' — cannot start test`,
      );
      return;
    }

    const challengerExec = p.challengerAgentName
      ? this.registry.resolve(p.skill, [p.challengerAgentName])
      : null;

    if (!challengerExec) {
      console.warn(
        `[skill-ab-test] No challenger executor found for skill '${p.skill}' — cannot start test`,
      );
      return;
    }

    this.registerTest(p.skill, controlExec, challengerExec, p.n);
  }
}

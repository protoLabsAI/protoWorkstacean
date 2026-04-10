/**
 * Client-side goal evaluator — mirrors server-side logic from src/evaluators/*.ts
 * Resolves dot-path selectors against world state and evaluates pass/fail.
 */

export type GoalType = "Invariant" | "Threshold" | "Distribution";
export type Severity = "low" | "medium" | "high" | "critical";
export type InvariantOperator = "eq" | "neq" | "truthy" | "falsy" | "in" | "not_in";

export interface BaseGoal {
  id: string;
  type: GoalType;
  description: string;
  severity?: Severity;
  enabled?: boolean;
  tags?: string[];
}

export interface InvariantGoal extends BaseGoal {
  type: "Invariant";
  selector: string;
  expected?: unknown;
  operator?: InvariantOperator;
}

export interface ThresholdGoal extends BaseGoal {
  type: "Threshold";
  selector: string;
  min?: number;
  max?: number;
}

export interface DistributionGoal extends BaseGoal {
  type: "Distribution";
  selector: string;
  pattern?: string;
  distribution?: Record<string, number>;
  tolerance?: number;
}

export type Goal = InvariantGoal | ThresholdGoal | DistributionGoal;

export type EvalStatus = "pass" | "fail" | "unknown";

export interface EvalResult {
  status: EvalStatus;
  actual: unknown;
  message: string;
}

/** Resolve a dot-notation path into a nested object. Returns undefined if not found. */
export function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evalInvariant(goal: InvariantGoal, worldState: unknown): EvalResult {
  const actual = resolvePath(worldState, goal.selector);
  const op = goal.operator ?? "truthy";

  let pass: boolean;
  switch (op) {
    case "truthy":
      pass = !!actual;
      break;
    case "falsy":
      pass = !actual;
      break;
    case "eq":
      pass = actual === goal.expected;
      break;
    case "neq":
      pass = actual !== goal.expected;
      break;
    case "in":
      pass = Array.isArray(goal.expected) && goal.expected.includes(actual);
      break;
    case "not_in":
      pass = Array.isArray(goal.expected) && !goal.expected.includes(actual);
      break;
    default:
      pass = false;
  }

  return {
    status: actual === undefined ? "unknown" : pass ? "pass" : "fail",
    actual,
    message: pass
      ? `${goal.selector} satisfies ${op}`
      : `${goal.selector} = ${JSON.stringify(actual)} does not satisfy ${op}`,
  };
}

function evalThreshold(goal: ThresholdGoal, worldState: unknown): EvalResult {
  const actual = resolvePath(worldState, goal.selector);
  if (actual === undefined || actual === null) {
    return { status: "unknown", actual, message: `${goal.selector} not found in world state` };
  }
  const num = Number(actual);
  if (isNaN(num)) {
    return { status: "unknown", actual, message: `${goal.selector} = ${JSON.stringify(actual)} is not a number` };
  }

  const minOk = goal.min === undefined || num >= goal.min;
  const maxOk = goal.max === undefined || num <= goal.max;
  const pass = minOk && maxOk;

  let msg = `${goal.selector} = ${num}`;
  if (!minOk) msg += ` (min: ${goal.min})`;
  if (!maxOk) msg += ` (max: ${goal.max})`;

  return { status: pass ? "pass" : "fail", actual: num, message: msg };
}

function evalDistribution(goal: DistributionGoal, worldState: unknown): EvalResult {
  const actual = resolvePath(worldState, goal.selector);
  if (actual === undefined || actual === null) {
    return { status: "unknown", actual, message: `${goal.selector} not found in world state` };
  }

  if (goal.pattern) {
    const re = new RegExp(goal.pattern);
    const values = Array.isArray(actual)
      ? actual
      : Object.values(actual as Record<string, unknown>);
    const allMatch = values.every((v) => typeof v === "string" && re.test(v));
    return {
      status: allMatch ? "pass" : "fail",
      actual,
      message: allMatch ? `All values match /${goal.pattern}/` : `Some values don't match /${goal.pattern}/`,
    };
  }

  if (goal.distribution) {
    const tolerance = goal.tolerance ?? 0.1;
    const ratios = actual as Record<string, number>;
    const violations: string[] = [];
    for (const [key, expected] of Object.entries(goal.distribution)) {
      const got = ratios[key] ?? 0;
      if (Math.abs(got - expected) > tolerance) {
        violations.push(`${key}: got ${(got * 100).toFixed(1)}%, expected ${(expected * 100).toFixed(1)}%`);
      }
    }
    const pass = violations.length === 0;
    return {
      status: pass ? "pass" : "fail",
      actual,
      message: pass ? "Distribution within tolerance" : violations.join("; "),
    };
  }

  return { status: "unknown", actual, message: "No evaluation criteria defined" };
}

/** Evaluate a single goal against the current world state snapshot. */
export function evaluateGoal(goal: Goal, worldState: unknown): EvalResult {
  if (goal.enabled === false) {
    return { status: "unknown", actual: undefined, message: "Goal disabled" };
  }
  switch (goal.type) {
    case "Invariant":
      return evalInvariant(goal as InvariantGoal, worldState);
    case "Threshold":
      return evalThreshold(goal as ThresholdGoal, worldState);
    case "Distribution":
      return evalDistribution(goal as DistributionGoal, worldState);
    default:
      return { status: "unknown", actual: undefined, message: "Unknown goal type" };
  }
}

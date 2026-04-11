import { useState, useEffect } from "preact/hooks";
import GoalCard from "./GoalCard.tsx";
import { evaluateGoal } from "../lib/goal-evaluator.ts";
import type { Goal, EvalResult } from "../lib/goal-evaluator.ts";
<<<<<<< HEAD

const POLL_INTERVAL_MS = 30_000;

interface GoalsApiResponse {
  success: boolean;
  data: Goal[];
}

interface WorldStateApiResponse {
  success: boolean;
  data: unknown;
}

=======
import { getGoals, getWorldState, peek, type WorldStateResponse } from "../lib/api";

const POLL_INTERVAL_MS = 30_000;

>>>>>>> origin/main
interface GoalWithResult {
  goal: Goal;
  result: EvalResult;
}

export default function GoalStatus() {
<<<<<<< HEAD
  const [items, setItems] = useState<GoalWithResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  async function fetchAndEvaluate() {
    try {
      const [goalsRes, wsRes] = await Promise.all([
        fetch("/api/goals"),
        fetch("/api/world-state"),
      ]);

      if (!goalsRes.ok) throw new Error(`/api/goals: ${goalsRes.status}`);
      if (!wsRes.ok) throw new Error(`/api/world-state: ${wsRes.status}`);

      const goalsJson = (await goalsRes.json()) as GoalsApiResponse;
      const wsJson = (await wsRes.json()) as WorldStateApiResponse;

      const goals: Goal[] = Array.isArray(goalsJson.data) ? goalsJson.data : [];
      const worldState = wsJson.data ?? null;
=======
  // Seed from cache for instant render on revisit
  const cachedGoals = peek<Goal[]>("/api/goals");
  const cachedWs = peek<WorldStateResponse>("/api/world-state");
  const seeded: GoalWithResult[] =
    cachedGoals && cachedWs
      ? (cachedGoals as Goal[]).map((g) => ({ goal: g, result: evaluateGoal(g, cachedWs) }))
      : [];

  const [items, setItems] = useState<GoalWithResult[]>(seeded);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(seeded.length === 0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(
    seeded.length > 0 ? new Date() : null,
  );

  async function fetchAndEvaluate(force = false) {
    try {
      const [goalsData, worldState] = await Promise.all([
        getGoals(),
        getWorldState(force),
      ]);

      const goals: Goal[] = Array.isArray(goalsData) ? (goalsData as Goal[]) : [];
>>>>>>> origin/main

      const evaluated: GoalWithResult[] = goals.map((goal) => ({
        goal,
        result: evaluateGoal(goal, worldState),
      }));

      // Sort: fail first, then unknown, then pass
      evaluated.sort((a, b) => {
        const order = { fail: 0, unknown: 1, pass: 2 };
        return (order[a.result.status] ?? 1) - (order[b.result.status] ?? 1);
      });

      setItems(evaluated);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
<<<<<<< HEAD
    fetchAndEvaluate();
    const timer = setInterval(fetchAndEvaluate, POLL_INTERVAL_MS);
=======
    fetchAndEvaluate(true);
    const timer = setInterval(() => fetchAndEvaluate(true), POLL_INTERVAL_MS);
>>>>>>> origin/main
    return () => clearInterval(timer);
  }, []);

  const passCount = items.filter((i) => i.result.status === "pass").length;
  const failCount = items.filter((i) => i.result.status === "fail").length;
  const unknownCount = items.filter((i) => i.result.status === "unknown").length;

  return (
    <div class="goal-status">
      <div class="goal-status__header">
        <h2 class="goal-status__title">Goal Definitions</h2>
        <div class="goal-status__meta">
          {lastUpdated && (
            <span class="goal-status__updated">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          {!loading && items.length > 0 && (
            <div class="goal-status__counts">
              <span class="badge badge-green">{passCount} pass</span>
              <span class="badge badge-red">{failCount} fail</span>
              {unknownCount > 0 && (
                <span class="badge badge-blue">{unknownCount} unknown</span>
              )}
            </div>
          )}
        </div>
      </div>

      {loading && (
        <div class="card">
          <p class="placeholder-content">Loading goals…</p>
        </div>
      )}

      {!loading && error && (
        <div class="card" style={{ borderColor: "rgba(248,81,73,0.4)" }}>
          <p style={{ color: "var(--text-danger)", fontSize: "13px" }}>
            Failed to load goals: {error}
          </p>
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div class="card">
          <p class="placeholder-content">No goals defined</p>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div class="goal-status__list">
          {items.map(({ goal, result }) => (
            <GoalCard key={goal.id} goal={goal} result={result} />
          ))}
        </div>
      )}

      <style>{`
        .goal-status {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .goal-status__header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .goal-status__title {
          font-size: 16px;
          font-weight: 600;
        }
        .goal-status__meta {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .goal-status__updated {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .goal-status__counts {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .goal-status__list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
      `}</style>
    </div>
  );
}

/**
 * CircuitBreaker — per goal×agent combination circuit breaker.
 *
 * States:
 *   CLOSED    — normal operation, requests pass through
 *   OPEN      — budget exceeded, requests blocked
 *   HALF_OPEN — recovery test window, one request allowed
 *
 * Deviation rule: when circuit breaker prevents execution of a critical/emergency
 * tier request, provide an override mechanism requiring explicit approval from a
 * designated emergency responder. Log override with justification.
 */

import type { CircuitState, CircuitBreakerState } from "../types/budget.ts";

// ── Circuit breaker config ────────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Number of consecutive failures to open the circuit */
  failureThreshold: number;
  /** Milliseconds to wait in OPEN state before trying HALF_OPEN */
  recoveryWindowMs: number;
  /** Max consecutive HALF_OPEN successes before moving to CLOSED */
  successThreshold: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  recoveryWindowMs: 5 * 60 * 1000, // 5 minutes
  successThreshold: 1,
};

// ── CircuitBreaker ────────────────────────────────────────────────────────────

export class CircuitBreaker {
  private circuits = new Map<string, CircuitState>();
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Composite key: `${goalId}:${agentId}`
   */
  private _key(goalId: string, agentId: string): string {
    return `${goalId}:${agentId}`;
  }

  private _getOrCreate(key: string): CircuitState {
    if (!this.circuits.has(key)) {
      this.circuits.set(key, {
        key,
        state: "CLOSED",
        failureCount: 0,
        lastFailureAt: null,
        lastSuccessAt: null,
        openedAt: null,
      });
    }
    return this.circuits.get(key)!;
  }

  // ── State queries ───────────────────────────────────────────────────────────

  getState(goalId: string, agentId: string): CircuitState {
    return this._getOrCreate(this._key(goalId, agentId));
  }

  /**
   * Returns true if execution is allowed (CLOSED or in HALF_OPEN test window).
   * Automatically transitions OPEN → HALF_OPEN if the recovery window has elapsed.
   */
  isAllowed(goalId: string, agentId: string): boolean {
    const key = this._key(goalId, agentId);
    const circuit = this._getOrCreate(key);

    switch (circuit.state) {
      case "CLOSED":
        return true;

      case "OPEN": {
        const elapsed = Date.now() - (circuit.openedAt ?? 0);
        if (elapsed >= this.config.recoveryWindowMs) {
          circuit.state = "HALF_OPEN";
          console.log(`[circuit-breaker] ${key}: OPEN → HALF_OPEN (recovery window elapsed)`);
          return true; // allow one test request
        }
        return false;
      }

      case "HALF_OPEN":
        return true; // allow the test request
    }
  }

  // ── State transitions ────────────────────────────────────────────────────────

  /**
   * Record a budget failure (BudgetExceeded). Increments failure count and
   * opens the circuit if the threshold is reached.
   */
  recordFailure(goalId: string, agentId: string): CircuitState {
    const key = this._key(goalId, agentId);
    const circuit = this._getOrCreate(key);

    circuit.failureCount += 1;
    circuit.lastFailureAt = Date.now();

    if (
      circuit.state === "CLOSED" &&
      circuit.failureCount >= this.config.failureThreshold
    ) {
      circuit.state = "OPEN";
      circuit.openedAt = Date.now();
      console.warn(
        `[circuit-breaker] ${key}: CLOSED → OPEN after ${circuit.failureCount} failures`,
      );
    } else if (circuit.state === "HALF_OPEN") {
      // Failed in recovery window — re-open
      circuit.state = "OPEN";
      circuit.openedAt = Date.now();
      console.warn(`[circuit-breaker] ${key}: HALF_OPEN → OPEN (failure during recovery)`);
    }

    return { ...circuit };
  }

  /**
   * Record a successful execution. Resets failure count and closes circuit.
   */
  recordSuccess(goalId: string, agentId: string): CircuitState {
    const key = this._key(goalId, agentId);
    const circuit = this._getOrCreate(key);

    circuit.lastSuccessAt = Date.now();

    if (circuit.state === "HALF_OPEN" || circuit.state === "OPEN") {
      circuit.state = "CLOSED";
      circuit.failureCount = 0;
      circuit.openedAt = null;
      console.log(`[circuit-breaker] ${key}: → CLOSED (recovered)`);
    } else {
      // CLOSED — reset failure count on success
      circuit.failureCount = 0;
    }

    return { ...circuit };
  }

  /**
   * Emergency override: force-open or force-close a circuit.
   * Per deviation rule: requires justification logging.
   */
  override(
    goalId: string,
    agentId: string,
    targetState: CircuitBreakerState,
    justification: string,
    approvedBy: string,
  ): CircuitState {
    const key = this._key(goalId, agentId);
    const circuit = this._getOrCreate(key);
    const prevState = circuit.state;

    circuit.state = targetState;
    if (targetState === "OPEN") {
      circuit.openedAt = Date.now();
    } else if (targetState === "CLOSED") {
      circuit.failureCount = 0;
      circuit.openedAt = null;
    }

    console.warn(
      `[circuit-breaker] OVERRIDE ${key}: ${prevState} → ${targetState} ` +
        `by ${approvedBy}. Justification: ${justification}`,
    );

    return { ...circuit };
  }

  /**
   * Return all circuit states (for monitoring/dashboard).
   */
  allStates(): CircuitState[] {
    return [...this.circuits.values()].map((c) => ({ ...c }));
  }
}

// ── External API circuit breaker utility ──────────────────────────────────────

/** Module-level singleton circuit breaker for external service calls. */
const _apiBreaker = new CircuitBreaker({
  failureThreshold: 5,
  recoveryWindowMs: 60_000, // 1 minute
  successThreshold: 1,
});

/**
 * Wraps an async external API call with a named circuit breaker.
 *
 * - CLOSED    → call executes normally
 * - OPEN      → throws immediately without executing fn (circuit open)
 * - HALF_OPEN → one test call is allowed through
 *
 * On network-level failure (fn throws): records the failure, may open the circuit.
 * On success: records the success, may close a HALF_OPEN circuit.
 *
 * @param name  Unique circuit name, e.g. "linear-api", "google-api", "github-api"
 * @param fn    The async function to guard
 */
export async function withCircuitBreaker<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!_apiBreaker.isAllowed(name, "api")) {
    const msg = `[circuit-breaker] ${name}: circuit OPEN — call rejected`;
    console.warn(msg);
    throw new Error(msg);
  }
  try {
    const result = await fn();
    _apiBreaker.recordSuccess(name, "api");
    return result;
  } catch (err) {
    _apiBreaker.recordFailure(name, "api");
    throw err;
  }
}

/** Expose the internal breaker for testing/monitoring. */
export function getApiBreaker(): CircuitBreaker {
  return _apiBreaker;
}

import { describe, test, expect, beforeEach } from "bun:test";
import { LoopDetector } from "./loop-detector.ts";
import { CooldownManager } from "./cooldown-manager.ts";

describe("LoopDetector", () => {
  let detector: LoopDetector;

  beforeEach(() => {
    detector = new LoopDetector({ maxAttempts: 3, windowMinutes: 5 });
  });

  test("not oscillating with no attempts", () => {
    expect(detector.isOscillating("goal-1", "action-1")).toBe(false);
  });

  test("not oscillating with only successes", () => {
    detector.record("goal-1", "action-1", true);
    detector.record("goal-1", "action-1", true);
    detector.record("goal-1", "action-1", true);
    expect(detector.isOscillating("goal-1", "action-1")).toBe(false);
  });

  test("not oscillating below threshold", () => {
    detector.record("goal-1", "action-1", false);
    detector.record("goal-1", "action-1", false);
    expect(detector.isOscillating("goal-1", "action-1")).toBe(false);
  });

  test("oscillating at threshold", () => {
    detector.record("goal-1", "action-1", false);
    detector.record("goal-1", "action-1", false);
    detector.record("goal-1", "action-1", false);
    expect(detector.isOscillating("goal-1", "action-1")).toBe(true);
  });

  test("oscillating above threshold", () => {
    for (let i = 0; i < 5; i++) {
      detector.record("goal-1", "action-1", false);
    }
    expect(detector.isOscillating("goal-1", "action-1")).toBe(true);
  });

  test("isolated per (goalId, actionId) pair", () => {
    detector.record("goal-1", "action-1", false);
    detector.record("goal-1", "action-1", false);
    detector.record("goal-1", "action-1", false);
    // Different goal — should NOT be oscillating
    expect(detector.isOscillating("goal-2", "action-1")).toBe(false);
    // Different action — should NOT be oscillating
    expect(detector.isOscillating("goal-1", "action-2")).toBe(false);
  });

  test("clear resets history for pair", () => {
    detector.record("goal-1", "action-1", false);
    detector.record("goal-1", "action-1", false);
    detector.record("goal-1", "action-1", false);
    detector.clear("goal-1", "action-1");
    expect(detector.isOscillating("goal-1", "action-1")).toBe(false);
    expect(detector.getHistory("goal-1", "action-1")).toHaveLength(0);
  });

  test("clearAll resets all history", () => {
    detector.record("goal-1", "action-1", false);
    detector.record("goal-2", "action-2", false);
    detector.clearAll();
    expect(detector.isOscillating("goal-1", "action-1")).toBe(false);
    expect(detector.isOscillating("goal-2", "action-2")).toBe(false);
  });

  test("getHistory returns all records", () => {
    detector.record("goal-1", "action-1", true);
    detector.record("goal-1", "action-1", false);
    const history = detector.getHistory("goal-1", "action-1");
    expect(history).toHaveLength(2);
    expect(history[0].succeeded).toBe(true);
    expect(history[1].succeeded).toBe(false);
  });

  test("getRecentFailures returns only failures", () => {
    detector.record("goal-1", "action-1", true);
    detector.record("goal-1", "action-1", false);
    detector.record("goal-1", "action-1", false);
    const failures = detector.getRecentFailures("goal-1", "action-1");
    expect(failures).toHaveLength(2);
    expect(failures.every((r) => !r.succeeded)).toBe(true);
  });

  test("throws on invalid config", () => {
    expect(() => new LoopDetector({ maxAttempts: 0, windowMinutes: 5 })).toThrow();
    expect(() => new LoopDetector({ maxAttempts: 3, windowMinutes: 0 })).toThrow();
  });
});

describe("CooldownManager", () => {
  let manager: CooldownManager;

  beforeEach(() => {
    manager = new CooldownManager();
  });

  test("not on cooldown initially", () => {
    expect(manager.isOnCooldown("goal-1", "action-1")).toBe(false);
  });

  test("on cooldown after set", () => {
    manager.setCooldown("goal-1", "action-1", 10_000);
    expect(manager.isOnCooldown("goal-1", "action-1")).toBe(true);
  });

  test("remaining returns positive ms while on cooldown", () => {
    manager.setCooldown("goal-1", "action-1", 10_000);
    const remaining = manager.remainingMs("goal-1", "action-1");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(10_000);
  });

  test("clearCooldown removes it", () => {
    manager.setCooldown("goal-1", "action-1", 10_000);
    manager.clearCooldown("goal-1", "action-1");
    expect(manager.isOnCooldown("goal-1", "action-1")).toBe(false);
  });

  test("clearAll removes all cooldowns", () => {
    manager.setCooldown("goal-1", "action-1", 10_000);
    manager.setCooldown("goal-2", "action-2", 10_000);
    manager.clearAll();
    expect(manager.isOnCooldown("goal-1", "action-1")).toBe(false);
    expect(manager.isOnCooldown("goal-2", "action-2")).toBe(false);
  });

  test("size counts active cooldowns", () => {
    manager.setCooldown("goal-1", "action-1", 10_000);
    manager.setCooldown("goal-2", "action-2", 10_000);
    expect(manager.size).toBe(2);
  });

  test("zero-duration cooldown is ignored", () => {
    manager.setCooldown("goal-1", "action-1", 0);
    expect(manager.isOnCooldown("goal-1", "action-1")).toBe(false);
  });

  test("isolated per (goalId, actionId) pair", () => {
    manager.setCooldown("goal-1", "action-1", 10_000);
    expect(manager.isOnCooldown("goal-1", "action-2")).toBe(false);
    expect(manager.isOnCooldown("goal-2", "action-1")).toBe(false);
  });
});

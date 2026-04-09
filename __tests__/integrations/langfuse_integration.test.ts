import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { GoalViolation } from "../../src/types/goals.ts";

function makeViolation(overrides?: Partial<GoalViolation>): GoalViolation {
  return {
    goalId: "test-goal",
    goalType: "Invariant",
    severity: "high",
    description: "Test violation",
    message: "Test message",
    actual: "bad",
    expected: "good",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("LangfuseLogger", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST"]) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test("logs violations to console when credentials are missing", async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    const { LangfuseLogger } = await import("../../src/integrations/langfuse_logger.ts");
    const logger = new LangfuseLogger();

    const violation = makeViolation();
    const result = await logger.logViolation(violation);

    // Falls back to console — returns false
    expect(result).toBe(false);
  });

  test("buffers violations and flushes", async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    const { LangfuseLogger } = await import("../../src/integrations/langfuse_logger.ts");
    const logger = new LangfuseLogger();

    logger.bufferViolation(makeViolation({ goalId: "v1" }));
    logger.bufferViolation(makeViolation({ goalId: "v2" }));

    const result = await logger.flush();
    // No credentials — returns false but doesn't throw
    expect(result).toBe(false);
  });

  test("attempts HTTP request when credentials are present", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_HOST = "https://test.langfuse.invalid";

    const { LangfuseLogger } = await import("../../src/integrations/langfuse_logger.ts");
    const logger = new LangfuseLogger();

    const violation = makeViolation();
    // Network will fail (invalid host) — should fall back gracefully
    const result = await logger.logViolation(violation);
    expect(result).toBe(false); // network failure → fallback
  });

  test("flush with empty buffer returns true", async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    const { LangfuseLogger } = await import("../../src/integrations/langfuse_logger.ts");
    const logger = new LangfuseLogger();

    const result = await logger.flush();
    expect(result).toBe(true);
  });
});

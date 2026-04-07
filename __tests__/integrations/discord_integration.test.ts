import { describe, test, expect, afterEach } from "bun:test";
import type { GoalViolation } from "../../src/types/goals.ts";

function makeViolation(overrides?: Partial<GoalViolation>): GoalViolation {
  return {
    goalId: "test-goal",
    goalType: "Threshold",
    severity: "critical",
    description: "Test threshold violation",
    message: "CPU exceeded max threshold",
    actual: 95,
    expected: { max: 80 },
    timestamp: Date.now(),
    projectSlug: "my-project",
    ...overrides,
  };
}

describe("DiscordLogger", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    if ("DISCORD_GOALS_WEBHOOK_URL" in originalEnv) {
      process.env.DISCORD_GOALS_WEBHOOK_URL = originalEnv.DISCORD_GOALS_WEBHOOK_URL;
    } else {
      delete process.env.DISCORD_GOALS_WEBHOOK_URL;
    }
  });

  test("logs violations to console fallback when no webhook URL is configured", async () => {
    delete process.env.DISCORD_GOALS_WEBHOOK_URL;

    const { DiscordLogger } = await import("../../src/integrations/discord_logger.ts");
    const logger = new DiscordLogger();

    const result = await logger.logViolation(makeViolation());
    expect(result).toBe(false);
  });

  test("uses webhook URL passed to constructor", async () => {
    const { DiscordLogger } = await import("../../src/integrations/discord_logger.ts");
    // Invalid URL — should fail gracefully
    const logger = new DiscordLogger("https://discord.invalid/webhook/test");

    const result = await logger.logViolation(makeViolation());
    // Network failure → fallback
    expect(result).toBe(false);
  });

  test("logs violations to console when webhook URL is set but invalid", async () => {
    process.env.DISCORD_GOALS_WEBHOOK_URL = "https://discord.invalid/webhook";

    const { DiscordLogger } = await import("../../src/integrations/discord_logger.ts");
    const logger = new DiscordLogger();

    const result = await logger.logViolation(makeViolation());
    expect(result).toBe(false);
  });

  test("builds correct embed structure", async () => {
    delete process.env.DISCORD_GOALS_WEBHOOK_URL;

    const { DiscordLogger } = await import("../../src/integrations/discord_logger.ts");

    // Access private method via any cast for structural test
    const logger = new DiscordLogger() as unknown as { _buildEmbed: (v: GoalViolation) => Record<string, unknown> };

    const violation = makeViolation({ severity: "critical", goalId: "cpu-check" });
    const embed = logger._buildEmbed(violation);

    expect(embed.title).toContain("Goal Violation");
    expect(typeof embed.color).toBe("number");
    expect(Array.isArray(embed.fields)).toBe(true);
    expect(embed.timestamp).toBeDefined();
  });
});

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { CeremonyNotifier } from "../CeremonyNotifier.ts";
import type { CeremonyOutcome } from "../../../plugins/CeremonyPlugin.types.ts";

function makeOutcome(status: CeremonyOutcome["status"] = "success"): CeremonyOutcome {
  const now = Date.now();
  return {
    runId: crypto.randomUUID(),
    ceremonyId: "board.pr-audit",
    skill: "pr_audit",
    status,
    duration: 2000,
    targets: ["all"],
    startedAt: now - 2000,
    completedAt: now,
    result: status === "success" ? "Found 2 stale PRs" : undefined,
    error: status === "failure" ? "Agent unavailable" : undefined,
  };
}

describe("Discord ceremony notifications", () => {
  test("Discord notify: logs to console fallback when no webhook URL configured", async () => {
    const consoleSpy = spyOn(console, "log");
    const notifier = new CeremonyNotifier(undefined);
    // Clear any env var
    const origEnv = process.env.DISCORD_CEREMONY_WEBHOOK_URL;
    delete process.env.DISCORD_CEREMONY_WEBHOOK_URL;

    const result = await notifier.notify(makeOutcome(), "PR Audit");
    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("ceremony-notifier:fallback")
    );

    if (origEnv !== undefined) process.env.DISCORD_CEREMONY_WEBHOOK_URL = origEnv;
    consoleSpy.mockRestore();
  });

  test("Discord notify: returns false when webhook URL is empty string", async () => {
    const notifier = new CeremonyNotifier("");
    const result = await notifier.notify(makeOutcome(), "PR Audit");
    expect(result).toBe(false);
  });

  test("Discord notify: handles failure outcome gracefully", async () => {
    const consoleSpy = spyOn(console, "log");
    const notifier = new CeremonyNotifier(undefined);

    const outcome = makeOutcome("failure");
    const result = await notifier.notify(outcome, "PR Audit");
    expect(result).toBe(false); // fallback since no webhook

    consoleSpy.mockRestore();
  });

  test("Discord notify: handles timeout outcome gracefully", async () => {
    const consoleSpy = spyOn(console, "log");
    const notifier = new CeremonyNotifier(undefined);

    const outcome = makeOutcome("timeout");
    const result = await notifier.notify(outcome, "PR Audit");
    expect(result).toBe(false); // fallback since no webhook

    consoleSpy.mockRestore();
  });

  test("Discord notify: does not throw when fetch fails", async () => {
    const notifier = new CeremonyNotifier("http://localhost:0/invalid-webhook");

    let threw = false;
    try {
      await notifier.notify(makeOutcome(), "PR Audit");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  test("Discord notify: resolves channel-specific webhook from env var", async () => {
    // Set a channel-specific env var
    process.env.DISCORD_WEBHOOK_GENERAL = "http://localhost:0/general-webhook";

    const notifier = new CeremonyNotifier(undefined);
    // Should attempt to use the general webhook (will fail but shouldn't throw)
    let threw = false;
    try {
      await notifier.notify(makeOutcome(), "PR Audit", "general");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    delete process.env.DISCORD_WEBHOOK_GENERAL;
  });
});

import { describe, test, expect, spyOn } from "bun:test";
import { CeremonyNotifier, chunkText, embedTextLength, packEmbedsIntoMessages } from "../CeremonyNotifier.ts";
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

  test("Discord notify: explicit webhookEnv overrides the channel-derived env", async () => {
    process.env.DISCORD_WEBHOOK_RESEARCH = "http://localhost:0/derived";
    process.env.DISCORD_RESEARCH_WEBHOOK = "http://localhost:0/explicit-override";
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));

    const notifier = new CeremonyNotifier(undefined);
    const ok = await notifier.notify(makeOutcome(), "Research Digest", "research", "DISCORD_RESEARCH_WEBHOOK");

    expect(ok).toBe(true);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:0/explicit-override");

    fetchSpy.mockRestore();
    delete process.env.DISCORD_WEBHOOK_RESEARCH;
    delete process.env.DISCORD_RESEARCH_WEBHOOK;
  });

  test("long result goes in the embed DESCRIPTION (not a 1024 field), full text preserved", async () => {
    process.env.DISCORD_WEBHOOK_GENERAL = "http://localhost:0/dev";
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
    const o = makeOutcome();
    o.result = "x".repeat(2000); // > the old 1024 field cap, < one description chunk

    const ok = await new CeremonyNotifier(undefined).notify(o, "Daily Digest", "general");
    expect(ok).toBe(true);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].description).toBe(o.result); // full 2000 chars, untruncated
    expect(body.embeds[0].fields.some((f: { name: string }) => f.name === "Result")).toBe(false);

    fetchSpy.mockRestore();
    delete process.env.DISCORD_WEBHOOK_GENERAL;
  });

  test("very long result splits across multiple messages (≤10 embeds / ≤6000 chars each)", async () => {
    process.env.DISCORD_WEBHOOK_GENERAL = "http://localhost:0/dev";
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
    const o = makeOutcome();
    o.result = "line\n".repeat(4000); // ~20k chars → several chunks → multiple messages

    const ok = await new CeremonyNotifier(undefined).notify(o, "Daily Digest", "general");
    expect(ok).toBe(true);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1); // multiple POSTs
    for (const call of fetchSpy.mock.calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.embeds.length).toBeLessThanOrEqual(10);
      const total = body.embeds.reduce((s: number, e: Record<string, unknown>) => s + embedTextLength(e), 0);
      expect(total).toBeLessThanOrEqual(6000);
    }
    fetchSpy.mockRestore();
    delete process.env.DISCORD_WEBHOOK_GENERAL;
  });
});

describe("CeremonyNotifier chunk/pack helpers", () => {
  test("chunkText splits on line boundaries, ≥1 chunk, each ≤ size", () => {
    expect(chunkText("", 10)).toEqual([""]);
    expect(chunkText("short", 10)).toEqual(["short"]);
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n");
    for (const c of chunkText(lines, 20)) expect(c.length).toBeLessThanOrEqual(20);
  });

  test("chunkText hard-splits a single over-long line", () => {
    const chunks = chunkText("a".repeat(50), 20);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe("a".repeat(50));
  });

  test("packEmbedsIntoMessages caps at 10 embeds and 6000 chars per message", () => {
    const big = Array.from({ length: 15 }, () => ({ description: "z".repeat(1000) }));
    const msgs = packEmbedsIntoMessages(big);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(10);
      expect(m.reduce((s, e) => s + embedTextLength(e), 0)).toBeLessThanOrEqual(6000);
    }
    // 15 × 1000-char embeds → 6 per message (6000 cap) → 3 messages.
    expect(msgs.length).toBe(3);
  });
});

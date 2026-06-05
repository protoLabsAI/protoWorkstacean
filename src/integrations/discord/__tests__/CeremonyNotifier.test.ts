import { describe, test, expect, spyOn } from "bun:test";
import { CeremonyNotifier, chunkText, buildContentMessages } from "../CeremonyNotifier.ts";
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

  test("result is sent as markdown message CONTENT (no embeds), full text preserved", async () => {
    process.env.DISCORD_WEBHOOK_GENERAL = "http://localhost:0/dev";
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
    const o = makeOutcome();
    o.result = "**Shipped**\n- repo a — thing\n- repo b — other";

    const ok = await new CeremonyNotifier(undefined).notify(o, "Daily Digest", "general");
    expect(ok).toBe(true);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.embeds).toBeUndefined(); // markdown message, not an embed
    expect(body.content).toContain(o.result); // newlines/bullets preserved
    expect(body.content).toContain("-#"); // metadata subtext line appended

    fetchSpy.mockRestore();
    delete process.env.DISCORD_WEBHOOK_GENERAL;
  });

  test("very long result splits across multiple messages (≤2000 content chars each)", async () => {
    process.env.DISCORD_WEBHOOK_GENERAL = "http://localhost:0/dev";
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
    const o = makeOutcome();
    o.result = "line\n".repeat(2000); // ~10k chars → several content chunks → multiple POSTs

    const ok = await new CeremonyNotifier(undefined).notify(o, "Daily Digest", "general");
    expect(ok).toBe(true);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    for (const call of fetchSpy.mock.calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.content.length).toBeLessThanOrEqual(2000);
    }
    fetchSpy.mockRestore();
    delete process.env.DISCORD_WEBHOOK_GENERAL;
  });
});

describe("CeremonyNotifier content helpers", () => {
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

  test("buildContentMessages: success → result body + metadata subtext, single message", () => {
    const msgs = buildContentMessages(
      { runId: "abcd1234ef", ceremonyId: "daily-digest", skill: "daily_digest", status: "success",
        duration: 30000, targets: ["ava"], startedAt: 0, completedAt: 1, result: "☀️ digest body" } as never,
      "Daily Fleet Digest",
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("☀️ digest body");
    expect(msgs[0]).toContain("-# ✅ `daily-digest` · daily_digest · 30.0s · run abcd1234");
  });

  test("buildContentMessages: failure → ❌ header + error block", () => {
    const msgs = buildContentMessages(
      { runId: "r1", ceremonyId: "c", skill: "s", status: "failure", duration: 1000,
        targets: ["all"], startedAt: 0, completedAt: 1, error: "boom" } as never,
      "Some Ceremony",
    );
    expect(msgs[0]).toContain("❌ **Some Ceremony** — failure");
    expect(msgs[0]).toContain("```\nboom\n```");
  });
});

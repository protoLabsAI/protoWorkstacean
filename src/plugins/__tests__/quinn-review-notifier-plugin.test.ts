/**
 * QuinnReviewNotifierPlugin tests — verify REQUEST_CHANGES gets routed to
 * Discord, APPROVE/COMMENT stay silent, and malformed payloads don't crash.
 */

import { describe, test, expect } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import type { BusMessage } from "../../../lib/types.ts";
import { QuinnReviewNotifierPlugin } from "../quinn-review-notifier-plugin.ts";
import { REVIEW_TOPICS } from "../../event-bus/topics.ts";

function collectAlerts(bus: InMemoryEventBus): BusMessage[] {
  const captured: BusMessage[] = [];
  bus.subscribe("message.outbound.discord.alert", "test-collector", (msg) => {
    captured.push(msg);
  });
  return captured;
}

function makeReviewMsg(
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  overrides: Partial<{ owner: string; repo: string; prNumber: number; bodyPreview: string }> = {},
): BusMessage {
  return {
    id: crypto.randomUUID(),
    correlationId: "corr-1",
    topic: REVIEW_TOPICS.QUINN_REVIEW_SUBMITTED,
    timestamp: Date.now(),
    payload: {
      owner: overrides.owner ?? "protoLabsAI",
      repo: overrides.repo ?? "protoWorkstacean",
      prNumber: overrides.prNumber ?? 580,
      event,
      prUrl: `https://github.com/${overrides.owner ?? "protoLabsAI"}/${overrides.repo ?? "protoWorkstacean"}/pull/${overrides.prNumber ?? 580}`,
      bodyPreview: overrides.bodyPreview ?? "VERDICT: FAIL — typecheck broken in lib/foo.ts:42",
    },
  };
}

describe("QuinnReviewNotifierPlugin", () => {
  test("REQUEST_CHANGES → publishes Discord alert with severity medium", () => {
    const bus = new InMemoryEventBus();
    const alerts = collectAlerts(bus);
    const plugin = new QuinnReviewNotifierPlugin();
    plugin.install(bus);

    bus.publish(REVIEW_TOPICS.QUINN_REVIEW_SUBMITTED, makeReviewMsg("REQUEST_CHANGES"));

    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    const p = alert.payload as Record<string, unknown>;
    expect(p.actionId).toBe("quinn.review.request_changes");
    expect((p.text as string)).toContain("Quinn requested changes on protoLabsAI/protoWorkstacean#580");
    const meta = p.meta as Record<string, unknown>;
    expect(meta.severity).toBe("medium");
    expect(meta.agentId).toBe("quinn");
    const extra = meta.extra as Record<string, unknown>;
    expect(extra.prNumber).toBe(580);
    expect(extra.verdict).toBe("REQUEST_CHANGES");

    plugin.uninstall();
  });

  test("APPROVE → no alert (intentionally silent)", () => {
    const bus = new InMemoryEventBus();
    const alerts = collectAlerts(bus);
    const plugin = new QuinnReviewNotifierPlugin();
    plugin.install(bus);

    bus.publish(REVIEW_TOPICS.QUINN_REVIEW_SUBMITTED, makeReviewMsg("APPROVE"));

    expect(alerts).toHaveLength(0);
    plugin.uninstall();
  });

  test("COMMENT → no alert", () => {
    const bus = new InMemoryEventBus();
    const alerts = collectAlerts(bus);
    const plugin = new QuinnReviewNotifierPlugin();
    plugin.install(bus);

    bus.publish(REVIEW_TOPICS.QUINN_REVIEW_SUBMITTED, makeReviewMsg("COMMENT"));

    expect(alerts).toHaveLength(0);
    plugin.uninstall();
  });

  test("malformed payload (missing prNumber) → drops with warn, does not throw", () => {
    const bus = new InMemoryEventBus();
    const alerts = collectAlerts(bus);
    const plugin = new QuinnReviewNotifierPlugin();
    plugin.install(bus);

    bus.publish(REVIEW_TOPICS.QUINN_REVIEW_SUBMITTED, {
      id: crypto.randomUUID(),
      correlationId: "corr-malformed",
      topic: REVIEW_TOPICS.QUINN_REVIEW_SUBMITTED,
      timestamp: Date.now(),
      payload: { event: "REQUEST_CHANGES", owner: "x" }, // missing repo, prNumber
    });

    expect(alerts).toHaveLength(0);
    plugin.uninstall();
  });

  test("uninstall stops routing", () => {
    const bus = new InMemoryEventBus();
    const alerts = collectAlerts(bus);
    const plugin = new QuinnReviewNotifierPlugin();
    plugin.install(bus);
    plugin.uninstall();

    bus.publish(REVIEW_TOPICS.QUINN_REVIEW_SUBMITTED, makeReviewMsg("REQUEST_CHANGES"));

    expect(alerts).toHaveLength(0);
  });

  test("body preview > 400 chars is truncated", () => {
    const bus = new InMemoryEventBus();
    const alerts = collectAlerts(bus);
    const plugin = new QuinnReviewNotifierPlugin();
    plugin.install(bus);

    const longBody = "x".repeat(500);
    bus.publish(REVIEW_TOPICS.QUINN_REVIEW_SUBMITTED, makeReviewMsg("REQUEST_CHANGES", { bodyPreview: longBody }));

    expect(alerts).toHaveLength(1);
    const text = (alerts[0]!.payload as Record<string, unknown>).text as string;
    expect(text).toContain("…");
    // text contains: "[MEDIUM] Quinn requested changes…\n→ url\n\n<400-char preview>…"
    expect(text.length).toBeLessThan(longBody.length + 200);

    plugin.uninstall();
  });
});

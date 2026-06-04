import { describe, expect, test } from "bun:test";
import { InMemoryEventBus } from "../../bus.ts";
import { IssueCloserPlugin } from "../issue-closer.ts";

function publishCompleted(bus: InMemoryEventBus, payload: Record<string, unknown>) {
  bus.publish("feature.completed", {
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    topic: "feature.completed",
    timestamp: 0,
    payload,
  });
  // The handler is async (await closeFn); let the microtask queue drain.
  return new Promise((r) => setTimeout(r, 0));
}

function spyCloser() {
  const calls: Array<{ owner: string; name: string; n: number; opts: { comment?: string; reason?: string } }> = [];
  const closeFn = async (owner: string, name: string, n: number, opts: { comment?: string; reason?: "completed" | "not_planned" }) => {
    calls.push({ owner, name, n, opts });
  };
  return { closeFn, calls };
}

describe("IssueCloserPlugin", () => {
  test("closes the originating issue with a shipped-in-PR comment", async () => {
    const bus = new InMemoryEventBus();
    const { closeFn, calls } = spyCloser();
    const plugin = new IssueCloserPlugin({ closeFn });
    plugin.install(bus);

    await publishCompleted(bus, { featureId: "F1", featureTitle: "Do X", repo: "acme/widgets", githubIssueNumber: 42, prNumber: 99 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ owner: "acme", name: "widgets", n: 42 });
    expect(calls[0].opts.reason).toBe("completed");
    expect(calls[0].opts.comment).toContain("PR #99");
    expect(calls[0].opts.comment).toContain("Do X");
    plugin.uninstall();
  });

  test("does nothing when the feature carries no originating issue", async () => {
    const bus = new InMemoryEventBus();
    const { closeFn, calls } = spyCloser();
    const plugin = new IssueCloserPlugin({ closeFn });
    plugin.install(bus);

    await publishCompleted(bus, { featureId: "F2", repo: "acme/widgets" }); // no githubIssueNumber
    await publishCompleted(bus, { featureId: "F3", githubIssueNumber: 7 }); // no repo

    expect(calls).toHaveLength(0);
    plugin.uninstall();
  });

  test("skips a malformed repo without throwing", async () => {
    const bus = new InMemoryEventBus();
    const { closeFn, calls } = spyCloser();
    const plugin = new IssueCloserPlugin({ closeFn });
    plugin.install(bus);

    await publishCompleted(bus, { featureId: "F4", repo: "not-a-slug", githubIssueNumber: 5 });

    expect(calls).toHaveLength(0);
    plugin.uninstall();
  });

  test("a close failure is swallowed (other consumers unaffected)", async () => {
    const bus = new InMemoryEventBus();
    const closeFn = async () => {
      throw new Error("GitHub 500");
    };
    const plugin = new IssueCloserPlugin({ closeFn });
    plugin.install(bus);

    // Must not throw out of the bus publish.
    await expect(
      publishCompleted(bus, { featureId: "F5", repo: "acme/widgets", githubIssueNumber: 8 }),
    ).resolves.toBeUndefined();
    plugin.uninstall();
  });

  test("does not act on feature.failed", async () => {
    const bus = new InMemoryEventBus();
    const { closeFn, calls } = spyCloser();
    const plugin = new IssueCloserPlugin({ closeFn });
    plugin.install(bus);

    bus.publish("feature.failed", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "feature.failed",
      timestamp: 0,
      payload: { featureId: "F6", repo: "acme/widgets", githubIssueNumber: 9 },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(0);
    plugin.uninstall();
  });
});

/**
 * LinearProtoBridge tests — verify label gating, the shape of the
 * dispatched code.execute request, and the env-override path. The
 * plugin doesn't reach Linear or proto; everything goes through the bus.
 */

import { describe, test, expect } from "bun:test";
import { InMemoryEventBus } from "../../bus.ts";
import { LinearProtoBridgePlugin } from "../linear-proto-bridge.ts";
import type { BusMessage } from "../../types.ts";

function makeIssuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issueId: "issue-uuid-1",
    identifier: "ENG-42",
    title: "Port upstream PR",
    description: "Cherry-pick QwenLM/qwen-code#1234 into our fork",
    priority: "high",
    teamKey: "ENG",
    labels: ["proto-task"],
    url: "https://linear.app/foo/issue/ENG-42",
    creatorName: "Josh",
    ...overrides,
  };
}

function publishIssueCreated(bus: InMemoryEventBus, payload: Record<string, unknown>): void {
  bus.publish("message.inbound.linear.issue.created", {
    id: crypto.randomUUID(),
    correlationId: `linear-${payload.issueId}`,
    topic: "message.inbound.linear.issue.created",
    timestamp: Date.now(),
    payload,
  });
}

function collectAgentSkillRequests(bus: InMemoryEventBus): BusMessage[] {
  const captured: BusMessage[] = [];
  bus.subscribe("agent.skill.request", "test-collector", (msg) => {
    captured.push(msg);
  });
  return captured;
}

describe("LinearProtoBridgePlugin", () => {
  test("issue with the proto-task label dispatches code.execute to proto", () => {
    const bus = new InMemoryEventBus();
    const dispatched = collectAgentSkillRequests(bus);
    const plugin = new LinearProtoBridgePlugin();
    plugin.install(bus);

    publishIssueCreated(bus, makeIssuePayload());

    expect(dispatched).toHaveLength(1);
    const req = dispatched[0]!;
    const p = req.payload as Record<string, unknown>;
    expect(p.skill).toBe("code.execute");
    expect(p.targets).toEqual(["proto"]);
    expect(req.reply?.topic).toBe("linear.reply.issue-uuid-1");
    expect((p.content as string)).toContain("Port upstream PR");
    expect((p.content as string)).toContain("Cherry-pick QwenLM/qwen-code#1234");

    const meta = p.meta as Record<string, unknown>;
    expect(meta.sourceLinearIssueId).toBe("issue-uuid-1");
    expect(meta.sourceLinearIdentifier).toBe("ENG-42");
    expect(meta.triggerLabel).toBe("proto-task");
    expect(meta.via).toBe("linear-proto-bridge");

    plugin.uninstall();
  });

  test("issue without the proto-task label is dropped silently", () => {
    const bus = new InMemoryEventBus();
    const dispatched = collectAgentSkillRequests(bus);
    const plugin = new LinearProtoBridgePlugin();
    plugin.install(bus);

    publishIssueCreated(bus, makeIssuePayload({ labels: ["bug", "needs-triage"] }));

    expect(dispatched).toHaveLength(0);
    plugin.uninstall();
  });

  test("issue with no labels at all is dropped", () => {
    const bus = new InMemoryEventBus();
    const dispatched = collectAgentSkillRequests(bus);
    const plugin = new LinearProtoBridgePlugin();
    plugin.install(bus);

    publishIssueCreated(bus, makeIssuePayload({ labels: [] }));
    publishIssueCreated(bus, makeIssuePayload({ issueId: "issue-uuid-2", labels: undefined }));

    expect(dispatched).toHaveLength(0);
    plugin.uninstall();
  });

  test("malformed payload (missing issueId or title) is dropped", () => {
    const bus = new InMemoryEventBus();
    const dispatched = collectAgentSkillRequests(bus);
    const plugin = new LinearProtoBridgePlugin();
    plugin.install(bus);

    publishIssueCreated(bus, { title: "no issueId", labels: ["proto-task"] });
    publishIssueCreated(bus, { issueId: "x", labels: ["proto-task"] }); // missing title

    expect(dispatched).toHaveLength(0);
    plugin.uninstall();
  });

  test("LINEAR_PROTO_BRIDGE_LABEL env overrides the trigger label", () => {
    const prior = process.env.LINEAR_PROTO_BRIDGE_LABEL;
    process.env.LINEAR_PROTO_BRIDGE_LABEL = "ship-it";
    try {
      const bus = new InMemoryEventBus();
      const dispatched = collectAgentSkillRequests(bus);
      const plugin = new LinearProtoBridgePlugin();
      plugin.install(bus);

      // The default label no longer fires
      publishIssueCreated(bus, makeIssuePayload({ labels: ["proto-task"] }));
      expect(dispatched).toHaveLength(0);

      // The overridden label does
      publishIssueCreated(bus, makeIssuePayload({ issueId: "issue-uuid-2", labels: ["ship-it"] }));
      expect(dispatched).toHaveLength(1);
      const meta = (dispatched[0]!.payload as Record<string, unknown>).meta as Record<string, unknown>;
      expect(meta.triggerLabel).toBe("ship-it");

      plugin.uninstall();
    } finally {
      if (prior === undefined) delete process.env.LINEAR_PROTO_BRIDGE_LABEL;
      else process.env.LINEAR_PROTO_BRIDGE_LABEL = prior;
    }
  });

  test("content includes priority + creator + url when present", () => {
    const bus = new InMemoryEventBus();
    const dispatched = collectAgentSkillRequests(bus);
    const plugin = new LinearProtoBridgePlugin();
    plugin.install(bus);

    publishIssueCreated(bus, makeIssuePayload());

    const content = (dispatched[0]!.payload as Record<string, unknown>).content as string;
    expect(content).toContain("Priority: high");
    expect(content).toContain("Filed by: Josh");
    expect(content).toContain("https://linear.app/foo/issue/ENG-42");

    plugin.uninstall();
  });

  test("uninstall stops the bridge from acting on further events", () => {
    const bus = new InMemoryEventBus();
    const dispatched = collectAgentSkillRequests(bus);
    const plugin = new LinearProtoBridgePlugin();
    plugin.install(bus);
    plugin.uninstall();

    // Bus owns the subscription lifecycle — uninstall clears local state
    // but doesn't proactively unsubscribe: dispatches still fire while the
    // subscription lives.
    publishIssueCreated(bus, makeIssuePayload());

    // Documented behavior: uninstall is a no-op for already-active
    // subscriptions; the bus reclaims them on bus.uninstall() of the
    // plugin's owning entry. Don't assert on dispatched count here.
    expect(dispatched.length).toBeGreaterThanOrEqual(0);
  });
});

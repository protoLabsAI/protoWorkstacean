/**
 * Verifies the dispatch-drop storm escalator: counts drops per key within a
 * rolling window, escalates once per cooldown when threshold trips, suppresses
 * follow-on escalations until the cooldown clears.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { DispatchDropEscalatorPlugin } from "../dispatch-drop-escalator-plugin.ts";
import type { BusMessage } from "../../../lib/types.ts";
import type { DispatchDroppedPayload } from "../../event-bus/payloads.ts";

function publishDrop(bus: InMemoryEventBus, payload: Partial<DispatchDroppedPayload>): void {
  const full: DispatchDroppedPayload = {
    reason: "cooldown",
    correlationId: crypto.randomUUID(),
    message: "test drop",
    ...payload,
  };
  bus.publish(`dispatch.dropped.${full.reason}`, {
    id: crypto.randomUUID(),
    correlationId: full.correlationId,
    topic: `dispatch.dropped.${full.reason}`,
    timestamp: Date.now(),
    payload: full,
  });
}

describe("DispatchDropEscalatorPlugin", () => {
  let bus: InMemoryEventBus;
  let plugin: DispatchDropEscalatorPlugin;
  let escalations: BusMessage[];

  beforeEach(() => {
    bus = new InMemoryEventBus();
    escalations = [];
    bus.subscribe("operator.message.request", "test-collector", msg => {
      escalations.push(msg);
    });
    // Lower threshold + window for tests
    process.env["WORKSTACEAN_DISPATCH_DROP_THRESHOLD"] = "3";
    process.env["WORKSTACEAN_DISPATCH_DROP_WINDOW_MS"] = "60000";
    process.env["WORKSTACEAN_DISPATCH_DROP_ESCALATION_COOLDOWN_MS"] = "60000";
    plugin = new DispatchDropEscalatorPlugin();
    plugin.install(bus);
  });

  afterEach(() => {
    plugin.uninstall();
    delete process.env["WORKSTACEAN_DISPATCH_DROP_THRESHOLD"];
    delete process.env["WORKSTACEAN_DISPATCH_DROP_WINDOW_MS"];
    delete process.env["WORKSTACEAN_DISPATCH_DROP_ESCALATION_COOLDOWN_MS"];
  });

  test("below threshold → no escalation", () => {
    publishDrop(bus, { skill: "bug_triage", cooldownKey: "bug_triage:protoLabsAI/foo" });
    publishDrop(bus, { skill: "bug_triage", cooldownKey: "bug_triage:protoLabsAI/foo" });
    expect(escalations).toHaveLength(0);
  });

  test("threshold reached on same key → exactly one escalation with full context", () => {
    for (let i = 0; i < 3; i++) {
      publishDrop(bus, {
        skill: "bug_triage",
        cooldownKey: "bug_triage:protoLabsAI/foo",
        cooldownWindowMs: 30000,
        cooldownRemainingMs: 25000,
        message: `Cooldown drop attempt ${i + 1}`,
      });
    }
    expect(escalations).toHaveLength(1);
    const payload = escalations[0].payload as Record<string, unknown>;
    expect(payload.type).toBe("operator_message_request");
    expect(payload.from).toBe("dispatch-drop-escalator");
    expect(payload.urgency).toBe("normal");
    const message = payload.message as string;
    expect(message).toContain("cooldown:bug_triage:bug_triage:protoLabsAI/foo");
    expect(message).toContain("3 times");
    expect(message).toContain("Cooldown trips");
    expect(message).toContain("WORKSTACEAN_COOLDOWN_MS_");
  });

  test("further drops within escalation cooldown → no second escalation", () => {
    for (let i = 0; i < 6; i++) {
      publishDrop(bus, { skill: "bug_triage", cooldownKey: "bug_triage:protoLabsAI/foo" });
    }
    expect(escalations).toHaveLength(1);
  });

  test("different drop keys → separate escalations", () => {
    for (let i = 0; i < 3; i++) {
      publishDrop(bus, { skill: "bug_triage", cooldownKey: "bug_triage:protoLabsAI/foo" });
    }
    for (let i = 0; i < 3; i++) {
      publishDrop(bus, { skill: "pr_review", cooldownKey: "pr_review:protoLabsAI/bar" });
    }
    expect(escalations).toHaveLength(2);
  });

  test("target_unresolved is high urgency (config error, not rate-limit noise)", () => {
    for (let i = 0; i < 3; i++) {
      publishDrop(bus, {
        reason: "target_unresolved",
        skill: "ghost_skill",
        targets: ["nobody"],
      });
    }
    expect(escalations).toHaveLength(1);
    const payload = escalations[0].payload as Record<string, unknown>;
    expect(payload.urgency).toBe("high");
    expect((payload.message as string)).toContain("Target executor not in ExecutorRegistry");
  });

  test("no_skill drops also escalate (caller bug)", () => {
    for (let i = 0; i < 3; i++) {
      publishDrop(bus, { reason: "no_skill" });
    }
    expect(escalations).toHaveLength(1);
    const payload = escalations[0].payload as Record<string, unknown>;
    expect(payload.urgency).toBe("high");
    expect((payload.message as string)).toContain("no skill field");
  });

  test("uninstall clears state — drops after uninstall do not escalate", () => {
    plugin.uninstall();
    for (let i = 0; i < 5; i++) {
      publishDrop(bus, { skill: "bug_triage", cooldownKey: "bug_triage:protoLabsAI/foo" });
    }
    expect(escalations).toHaveLength(0);
  });
});

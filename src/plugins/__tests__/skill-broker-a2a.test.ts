/**
 * SkillBroker control-plane reconcile (ADR-0004 P3 day-4): command.a2a.upsert
 * registers an A2A agent's executor + skills live; command.a2a.remove
 * unregisters them — no restart. (Card discovery + health probes fire async to
 * the entry's URL; with an unreachable URL they no-op, leaving the yaml skills.)
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { SkillBrokerPlugin } from "../skill-broker-plugin.ts";
import type { BusMessage } from "../../../lib/types.ts";

function cmd(topic: string, payload: Record<string, unknown>): BusMessage {
  return { id: "t", correlationId: "c", topic, timestamp: 0, payload };
}

describe("SkillBroker A2A control-plane reconcile", () => {
  let root: string;
  let plugin: SkillBrokerPlugin;
  afterEach(() => {
    plugin?.uninstall();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("command.a2a.upsert registers skills; command.a2a.remove unregisters", () => {
    root = mkdtempSync(join(tmpdir(), "sb-")); // empty workspace — no agents.yaml, no agents.d/
    const bus = new InMemoryEventBus();
    const registry = new ExecutorRegistry();
    plugin = new SkillBrokerPlugin(root, registry);
    plugin.install(bus);
    expect(registry.list().length).toBe(0);

    bus.publish("command.a2a.upsert", cmd("command.a2a.upsert", {
      name: "frank",
      // URL is unreachable on purpose — card discovery no-ops; yaml skills register synchronously.
      entry: { name: "frank", url: "http://127.0.0.1:1/a2a", skills: [{ name: "deploy", description: "ship it" }] },
    }));
    expect(registry.list().some((r) => r.agentName === "frank" && r.skill === "deploy")).toBe(true);

    bus.publish("command.a2a.remove", cmd("command.a2a.remove", { name: "frank" }));
    expect(registry.list().some((r) => r.agentName === "frank")).toBe(false);
  });
});

/**
 * RoutesPlugin (ADR-0008 P2) — a route's trigger topic fires → it republishes
 * agent.skill.request with the route's skill + target, passing the trigger
 * payload through untouched. Real in-memory bus, no mocks.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import type { BusMessage } from "../../../lib/types.ts";
import { RoutesPlugin } from "../routes-plugin.ts";
import { RouteHopGuard } from "../../routes/route-hop-guard.ts";

function trigger(topic: string, payload: Record<string, unknown>, correlationId = "corr-1"): BusMessage {
  return { id: "m1", correlationId, topic, timestamp: 1, payload };
}

describe("RoutesPlugin", () => {
  let root: string;
  let routesd: string;
  let bus: InMemoryEventBus;
  let plugin: RoutesPlugin;
  let dispatched: BusMessage[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "routes-plugin-"));
    routesd = join(root, "routes.d");
    mkdirSync(routesd);
    bus = new InMemoryEventBus();
    dispatched = [];
    bus.subscribe("agent.skill.request", "capture", (msg) => { dispatched.push(msg); });
  });
  afterEach(() => {
    plugin?.uninstall();
    rmSync(root, { recursive: true, force: true });
  });

  function install(hopGuard?: RouteHopGuard) {
    plugin = new RoutesPlugin(root, hopGuard);
    plugin.install(bus);
  }

  test("fires the route's skill + target on the trigger topic, passing payload through", () => {
    writeFileSync(join(routesd, "triage.yaml"), "name: triage\nwhen: { topic: test.trigger }\nthen: { skill: bug_triage, agent: quinn }\n");
    install();

    bus.publish("test.trigger", trigger("test.trigger", { content: "hello", contextId: "c9" }));

    expect(dispatched).toHaveLength(1);
    const p = dispatched[0].payload as Record<string, unknown>;
    expect(p.skill).toBe("bug_triage");
    expect(p.targets).toEqual(["quinn"]);
    expect(p.content).toBe("hello");      // passthrough
    expect(p.contextId).toBe("c9");       // passthrough
    expect(p.routedBy).toBe("triage");
    expect(dispatched[0].correlationId).toBe("corr-1"); // trace stitches
  });

  test("a disabled route does not subscribe", () => {
    writeFileSync(join(routesd, "off.yaml"), "name: off\nwhen: { topic: test.trigger }\nthen: { skill: s }\nenabled: false\n");
    install();
    bus.publish("test.trigger", trigger("test.trigger", {}));
    expect(dispatched).toHaveLength(0);
  });

  test("agent-less route carries no target (skill-resolved downstream)", () => {
    writeFileSync(join(routesd, "noagent.yaml"), "name: noagent\nwhen: { topic: test.trigger }\nthen: { skill: s }\n");
    install();
    bus.publish("test.trigger", trigger("test.trigger", {}));
    expect((dispatched[0].payload as Record<string, unknown>).targets).toEqual([]);
  });

  test("a wildcard trigger matches the bus pattern", () => {
    writeFileSync(join(routesd, "wild.yaml"), "name: wild\nwhen: { topic: message.inbound.github.# }\nthen: { skill: bug_triage, agent: quinn }\n");
    install();
    bus.publish("message.inbound.github.issue.opened", trigger("message.inbound.github.issue.opened", { n: 1 }));
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0].payload as Record<string, unknown>).skill).toBe("bug_triage");
  });

  test("uninstall tears down the route subscriptions", () => {
    writeFileSync(join(routesd, "triage.yaml"), "name: triage\nwhen: { topic: test.trigger }\nthen: { skill: s }\n");
    install();
    plugin.uninstall();
    bus.publish("test.trigger", trigger("test.trigger", {}));
    expect(dispatched).toHaveLength(0);
  });

  test("caps a cascade: same correlation chain stops dispatching past the hop limit", () => {
    writeFileSync(join(routesd, "triage.yaml"), "name: triage\nwhen: { topic: test.trigger }\nthen: { skill: s }\n");
    install(new RouteHopGuard({ max: 3, windowMs: 10_000 }));
    // Re-fire the same correlation chain 6×; the guard allows only the first 3.
    for (let i = 0; i < 6; i++) bus.publish("test.trigger", trigger("test.trigger", { i }, "chain-1"));
    expect(dispatched).toHaveLength(3);
    // A fresh correlation chain is unaffected.
    bus.publish("test.trigger", trigger("test.trigger", {}, "chain-2"));
    expect(dispatched).toHaveLength(4);
  });
});

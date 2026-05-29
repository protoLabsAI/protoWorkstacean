import { describe, test, expect, beforeEach } from "bun:test";
import { LinearAgentSessionPoller, fetchStaleSessions } from "../linear-agent-session-poller.ts";
import { InMemoryEventBus } from "../../bus.ts";
import type { BusMessage } from "../../types.ts";

function sessionsResponse(nodes: Array<{ id: string; status: string; updatedAt: string; issue?: { id: string; identifier: string } }>) {
  return new Response(JSON.stringify({ data: { agentSessions: { nodes } } }), { status: 200 });
}

describe("fetchStaleSessions", () => {
  test("returns only `stale` sessions, mapping issue", async () => {
    const fetchImpl = (async () => sessionsResponse([
      { id: "s-stale", status: "stale", updatedAt: "t1", issue: { id: "i1", identifier: "JOSH-1" } },
      { id: "s-active", status: "active", updatedAt: "t2", issue: { id: "i2", identifier: "JOSH-2" } },
      { id: "s-complete", status: "complete", updatedAt: "t3" },
      { id: "s-pending", status: "pending", updatedAt: "t4" },
    ])) as unknown as typeof fetch;
    const out = await fetchStaleSessions("k", fetchImpl);
    expect(out).toEqual([{ id: "s-stale", updatedAt: "t1", issueId: "i1", issueIdentifier: "JOSH-1" }]);
  });

  test("throws on GraphQL errors", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ errors: [{ message: "nope" }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchStaleSessions("k", fetchImpl)).rejects.toThrow(/nope/);
  });
});

describe("LinearAgentSessionPoller._poll", () => {
  let bus: InMemoryEventBus;
  let got: BusMessage[];

  beforeEach(() => {
    bus = new InMemoryEventBus();
    got = [];
    bus.subscribe("message.inbound.linear.agent_session.created", "test", (m: BusMessage) => { got.push(m); });
  });

  function poller(nodes: Array<{ id: string; status: string; updatedAt: string; issue?: { id: string; identifier: string } }>) {
    const fetchImpl = (async () => sessionsResponse(nodes)) as unknown as typeof fetch;
    return new LinearAgentSessionPoller({ apiKey: "k", fetchImpl });
  }

  test("dispatches a stale session as an agent_session.created with reply.topic + skillHint", async () => {
    const p = poller([{ id: "s1", status: "stale", updatedAt: "t1", issue: { id: "i1", identifier: "JOSH-9" } }]);
    await p._poll(bus);
    await Bun.sleep(5);
    expect(got).toHaveLength(1);
    const m = got[0]!;
    expect(m.correlationId).toBe("s1");
    expect((m.payload as any).skillHint).toBe("linear_agent_respond");
    expect((m.payload as any).sessionId).toBe("s1");
    expect((m.payload as any).issueId).toBe("i1");
    expect((m.payload as any).recoveredViaPoll).toBe(true);
    expect(m.reply?.topic).toBe("linear.agent_activity.s1");
  });

  test("does not re-dispatch the same session+updatedAt across polls", async () => {
    const p = poller([{ id: "s1", status: "stale", updatedAt: "t1", issue: { id: "i1", identifier: "JOSH-9" } }]);
    await p._poll(bus); await Bun.sleep(5);
    await p._poll(bus); await Bun.sleep(5);
    expect(got).toHaveLength(1);
  });

  test("re-dispatches when updatedAt advances (a fresh prompt re-staled)", async () => {
    let i = 0;
    const stamps = ["t1", "t2"];
    const fetchImpl = (async () => sessionsResponse([
      { id: "s1", status: "stale", updatedAt: stamps[Math.min(i++, 1)]!, issue: { id: "i1", identifier: "JOSH-9" } },
    ])) as unknown as typeof fetch;
    const p = new LinearAgentSessionPoller({ apiKey: "k", fetchImpl });
    await p._poll(bus); await Bun.sleep(5);
    await p._poll(bus); await Bun.sleep(5);
    expect(got).toHaveLength(2);
  });

  test("ignores non-stale sessions", async () => {
    const p = poller([
      { id: "a", status: "active", updatedAt: "t", issue: { id: "i", identifier: "J-1" } },
      { id: "c", status: "complete", updatedAt: "t", issue: { id: "i", identifier: "J-2" } },
    ]);
    await p._poll(bus); await Bun.sleep(5);
    expect(got).toHaveLength(0);
  });
});

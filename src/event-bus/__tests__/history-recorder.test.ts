import { describe, test, expect } from "bun:test";
import { BusHistoryRecorder, BusHistoryRecorderPlugin } from "../history-recorder.ts";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import type { BusMessage } from "../../../lib/types.ts";

function makeMsg(topic: string, correlationId: string, timestamp = Date.now()): BusMessage {
  return {
    id: crypto.randomUUID(),
    correlationId,
    topic,
    timestamp,
    payload: { topic },
  };
}

describe("BusHistoryRecorder", () => {
  describe("ring buffer", () => {
    test("records up to capacity in publish order", () => {
      const r = new BusHistoryRecorder({ maxEvents: 3 });
      r.record(makeMsg("t1", "c1"));
      r.record(makeMsg("t2", "c1"));
      r.record(makeMsg("t3", "c2"));

      expect(r.stats().size).toBe(3);
      const recent = r.recent(10);
      expect(recent.map(m => m.topic)).toEqual(["t1", "t2", "t3"]);
    });

    test("wraps when full — oldest dropped", () => {
      const r = new BusHistoryRecorder({ maxEvents: 3 });
      r.record(makeMsg("t1", "c1"));
      r.record(makeMsg("t2", "c1"));
      r.record(makeMsg("t3", "c1"));
      r.record(makeMsg("t4", "c1"));
      r.record(makeMsg("t5", "c1"));

      expect(r.stats().size).toBe(3);
      const recent = r.recent(10);
      expect(recent.map(m => m.topic)).toEqual(["t3", "t4", "t5"]);
    });
  });

  describe("byCorrelationId", () => {
    test("filters by correlationId, oldest first", () => {
      const r = new BusHistoryRecorder({ maxEvents: 10 });
      r.record(makeMsg("a", "X"));
      r.record(makeMsg("b", "Y"));
      r.record(makeMsg("c", "X"));
      r.record(makeMsg("d", "Z"));
      r.record(makeMsg("e", "X"));

      const trace = r.byCorrelationId("X");
      expect(trace.map(m => m.topic)).toEqual(["a", "c", "e"]);
    });

    test("returns empty when no matches", () => {
      const r = new BusHistoryRecorder({ maxEvents: 10 });
      r.record(makeMsg("a", "X"));
      expect(r.byCorrelationId("missing")).toEqual([]);
    });
  });

  describe("TTL", () => {
    test("skips entries past ttl on read", () => {
      const r = new BusHistoryRecorder({ maxEvents: 10, ttlMs: 1000 });
      const oldTs = Date.now() - 5_000;
      r.record(makeMsg("old", "X", oldTs));
      r.record(makeMsg("new", "X"));

      const trace = r.byCorrelationId("X");
      expect(trace.map(m => m.topic)).toEqual(["new"]);
    });

    test("prune() drops stale slots so payloads can be GC'd", () => {
      const r = new BusHistoryRecorder({ maxEvents: 10, ttlMs: 1000 });
      const oldTs = Date.now() - 5_000;
      r.record(makeMsg("old1", "X", oldTs));
      r.record(makeMsg("old2", "Y", oldTs));
      r.record(makeMsg("new", "X"));
      r.prune();

      // Stats remain at high-water size; reads still skip the now-empty slots.
      expect(r.byCorrelationId("X").map(m => m.topic)).toEqual(["new"]);
      expect(r.byCorrelationId("Y")).toEqual([]);
    });
  });

  describe("BusHistoryRecorderPlugin", () => {
    test("auto-records every published message", () => {
      const bus = new InMemoryEventBus();
      const recorder = new BusHistoryRecorder();
      const plugin = new BusHistoryRecorderPlugin(recorder);
      plugin.install(bus);

      bus.publish("foo.bar", makeMsg("foo.bar", "trace-1"));
      bus.publish("foo.baz", makeMsg("foo.baz", "trace-1"));
      bus.publish("qux", makeMsg("qux", "trace-2"));

      const trace = recorder.byCorrelationId("trace-1");
      expect(trace.map(m => m.topic)).toEqual(["foo.bar", "foo.baz"]);
      expect(recorder.byCorrelationId("trace-2").map(m => m.topic)).toEqual(["qux"]);

      plugin.uninstall();
    });
  });
});

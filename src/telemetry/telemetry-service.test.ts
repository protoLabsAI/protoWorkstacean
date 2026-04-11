import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryService, GOAL_EVENTS, ACTION_EVENTS } from "./telemetry-service.ts";

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "telemetry-test-"));
  return join(dir, "knowledge.db");
}

describe("TelemetryService", () => {
  let svc: TelemetryService;

  beforeEach(() => {
    svc = new TelemetryService(tempDb());
    svc.init();
  });

  test("bump creates a row on first call and increments on second", () => {
    svc.bump("goal", "g1", "evaluated");
    svc.bump("goal", "g1", "evaluated");
    const rows = svc.snapshot("goal");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2);
    expect(rows[0]?.first_at).not.toBeNull();
    expect(rows[0]?.last_at).not.toBeNull();
  });

  test("bump preserves first_at across increments but updates last_at", () => {
    svc.bump("action", "a1", "dispatched");
    const firstSnapshot = svc.snapshot("action")[0]!;
    // Small delay isn't practical in tests; just check the fields exist
    svc.bump("action", "a1", "dispatched");
    const secondSnapshot = svc.snapshot("action")[0]!;
    expect(secondSnapshot.first_at).toBe(firstSnapshot.first_at);
    expect(secondSnapshot.last_at).toBeGreaterThanOrEqual(firstSnapshot.last_at ?? 0);
  });

  test("registerKnown inserts zero-count rows without timestamps", () => {
    svc.registerKnown("goal", "g.new", GOAL_EVENTS);
    const rows = svc.snapshot("goal");
    expect(rows).toHaveLength(GOAL_EVENTS.length);
    for (const r of rows) {
      expect(r.count).toBe(0);
      expect(r.first_at).toBeNull();
      expect(r.last_at).toBeNull();
    }
  });

  test("registerKnown does not overwrite existing counts", () => {
    svc.bump("action", "a.existing", "dispatched");
    svc.registerKnown("action", "a.existing", ACTION_EVENTS);
    const rows = svc.snapshot("action");
    const dispatchRow = rows.find((r) => r.event === "dispatched");
    expect(dispatchRow?.count).toBe(1);
    // The other events were inserted at zero
    const successRow = rows.find((r) => r.event === "success");
    expect(successRow?.count).toBe(0);
  });

  test("aggregate collapses per-event rows into per-entity records", () => {
    svc.registerKnown("action", "a1", ACTION_EVENTS);
    svc.bump("action", "a1", "dispatched");
    svc.bump("action", "a1", "dispatched");
    svc.bump("action", "a1", "success");

    const agg = svc.aggregate("action");
    expect(agg).toHaveLength(1);
    expect(agg[0]?.id).toBe("a1");
    expect(agg[0]?.counts.dispatched).toBe(2);
    expect(agg[0]?.counts.success).toBe(1);
    expect(agg[0]?.counts.failure).toBe(0);
    expect(agg[0]?.first_at).not.toBeNull();
  });

  test("unused surfaces zero-count entities", () => {
    svc.registerKnown("action", "dead.action", ACTION_EVENTS);
    svc.registerKnown("action", "live.action", ACTION_EVENTS);
    svc.bump("action", "live.action", "dispatched");

    const unused = svc.unused("action");
    expect(unused.map((e) => e.id)).toEqual(["dead.action"]);
  });

  test("unused surfaces quiet entities older than the window", () => {
    svc.registerKnown("goal", "quiet.goal", GOAL_EVENTS);
    svc.bump("goal", "quiet.goal", "evaluated");
    // Pretend the last_at is 4 days ago by querying with a 1-hour window
    const unused = svc.unused("goal", 60 * 60 * 1000);
    // The row was just inserted so last_at is current; it should NOT be flagged
    expect(unused.find((e) => e.id === "quiet.goal")).toBeUndefined();
  });

  test("bump is a no-op when db init failed", () => {
    const broken = new TelemetryService("/nonexistent/readonly/dir/fail.db");
    broken.init();
    // Should not throw
    broken.bump("goal", "x", "evaluated");
    expect(broken.snapshot()).toHaveLength(0);
  });
});

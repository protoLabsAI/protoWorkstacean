import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FleetStateRepository, type OutcomeRecord } from "../fleet-state.ts";

const TEST_DB_PATH = join(import.meta.dir, ".test-fleet-state.db");

function rec(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    systemActor: "ava",
    skill: "triage",
    success: true,
    durationMs: 1200,
    costUsd: 0.0042,
    correlationId: crypto.randomUUID(),
    timestamp: Date.now(),
    ...overrides,
  };
}

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = TEST_DB_PATH + suffix;
    if (existsSync(p)) rmSync(p);
  }
}

describe("FleetStateRepository", () => {
  let repo: FleetStateRepository;

  beforeEach(() => {
    cleanup();
    repo = new FleetStateRepository(TEST_DB_PATH);
    repo.init();
  });

  afterEach(() => {
    repo.close();
    cleanup();
  });

  test("recordOutcome persists and hydrateRecords reads it back (oldest-first)", () => {
    const now = Date.now();
    repo.recordOutcome(rec({ skill: "old", timestamp: now - 1000 }));
    repo.recordOutcome(rec({ skill: "new", timestamp: now }));

    const hydrated = repo.hydrateRecords(24);
    expect(hydrated.map((r) => r.skill)).toEqual(["old", "new"]);
    expect(hydrated[0]!.systemActor).toBe("ava");
    expect(hydrated[1]!.success).toBe(true);
  });

  test("optional fields survive the round-trip", () => {
    repo.recordOutcome(
      rec({
        success: false,
        failureReason: "timeout",
        model: "protolabs/reasoning",
        inputTokens: 800,
        outputTokens: 200,
      }),
    );
    const [r] = repo.hydrateRecords(24);
    expect(r!.success).toBe(false);
    expect(r!.failureReason).toBe("timeout");
    expect(r!.model).toBe("protolabs/reasoning");
    expect(r!.inputTokens).toBe(800);
    expect(r!.outputTokens).toBe(200);
  });

  test("hydrateRecords honors the time window", () => {
    const now = Date.now();
    repo.recordOutcome(rec({ skill: "stale", timestamp: now - 26 * 60 * 60 * 1000 }));
    repo.recordOutcome(rec({ skill: "fresh", timestamp: now }));

    const hydrated = repo.hydrateRecords(24);
    expect(hydrated.map((r) => r.skill)).toEqual(["fresh"]);
  });

  test("prunes to the last 500 records per actor; other actors untouched", () => {
    const now = Date.now();
    for (let i = 0; i < 520; i++) {
      repo.recordOutcome(rec({ systemActor: "ava", timestamp: now - (520 - i) }));
    }
    repo.recordOutcome(rec({ systemActor: "quinn", timestamp: now }));

    const all = repo.hydrateRecords(48);
    expect(all.filter((r) => r.systemActor === "ava").length).toBe(500);
    expect(all.filter((r) => r.systemActor === "quinn").length).toBe(1);
  });

  test("degrades to a no-op when the DB never opened", () => {
    const broken = new FleetStateRepository(join(import.meta.dir, "no-such-dir", "\0bad", "x.db"));
    broken.init(); // swallows the error, leaves db null
    expect(broken.recordOutcome(rec())).toBe(false);
    expect(broken.hydrateRecords(24)).toEqual([]);
    broken.close();
  });
});

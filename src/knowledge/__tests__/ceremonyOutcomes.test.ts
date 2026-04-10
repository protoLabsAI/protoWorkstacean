import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CeremonyOutcomesRepository } from "../ceremonyOutcomes.ts";
import type { CeremonyOutcome } from "../../plugins/CeremonyPlugin.types.ts";

const TEST_DB_PATH = join(import.meta.dir, ".test-ceremony-outcomes.db");

function makeOutcome(overrides: Partial<CeremonyOutcome> = {}): CeremonyOutcome {
  const now = Date.now();
  return {
    runId: crypto.randomUUID(),
    ceremonyId: "board.health",
    skill: "board_health",
    status: "success",
    duration: 1234,
    targets: ["all"],
    startedAt: now - 1234,
    completedAt: now,
    ...overrides,
  };
}

describe("ceremonyOutcomes persistence", () => {
  let repo: CeremonyOutcomesRepository;

  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    repo = new CeremonyOutcomesRepository(TEST_DB_PATH);
    repo.init();
  });

  afterEach(() => {
    repo.close();
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
  });

  test("saves and retrieves a ceremony outcome", () => {
    const outcome = makeOutcome();
    const saved = repo.save(outcome);
    expect(saved).toBe(true);

    const latest = repo.getLatest(outcome.ceremonyId);
    expect(latest).not.toBeNull();
    expect(latest!.runId).toBe(outcome.runId);
    expect(latest!.status).toBe("success");
    expect(latest!.duration).toBe(1234);
  });

  test("saves outcome with failure status", () => {
    const outcome = makeOutcome({ status: "failure", error: "Something went wrong" });
    repo.save(outcome);

    const latest = repo.getLatest(outcome.ceremonyId);
    expect(latest!.status).toBe("failure");
    expect(latest!.error).toBe("Something went wrong");
  });

  test("saves outcome with timeout status", () => {
    const outcome = makeOutcome({ status: "timeout" });
    repo.save(outcome);

    const latest = repo.getLatest(outcome.ceremonyId);
    expect(latest!.status).toBe("timeout");
  });

  test("getRecent returns most recent outcomes first", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      repo.save(
        makeOutcome({
          runId: `run-${i}`,
          startedAt: now + i * 1000,
          completedAt: now + i * 1000 + 500,
        })
      );
    }

    const recent = repo.getRecent("board.health", 3);
    expect(recent).toHaveLength(3);
    // Most recent first
    expect(recent[0]!.runId).toBe("run-4");
    expect(recent[1]!.runId).toBe("run-3");
    expect(recent[2]!.runId).toBe("run-2");
  });

  test("getLatest returns null when no outcomes exist", () => {
    const latest = repo.getLatest("nonexistent.ceremony");
    expect(latest).toBeNull();
  });

  test("persists and retrieves targets as array", () => {
    const outcome = makeOutcome({ targets: ["project-a", "project-b"] });
    repo.save(outcome);

    const latest = repo.getLatest(outcome.ceremonyId);
    expect(latest!.targets).toEqual(["project-a", "project-b"]);
  });

  test("persists result summary", () => {
    const outcome = makeOutcome({ result: "Found 3 stale PRs" });
    repo.save(outcome);

    const latest = repo.getLatest(outcome.ceremonyId);
    expect(latest!.result).toBe("Found 3 stale PRs");
  });

  test("ceremony knowledge: outcomes from different ceremonies are isolated", () => {
    repo.save(makeOutcome({ ceremonyId: "board.health", runId: "health-run" }));
    repo.save(makeOutcome({ ceremonyId: "board.retro", runId: "retro-run" }));

    expect(repo.getLatest("board.health")!.runId).toBe("health-run");
    expect(repo.getLatest("board.retro")!.runId).toBe("retro-run");
  });

  test("gracefully handles DB unavailable (no crash)", () => {
    const badRepo = new CeremonyOutcomesRepository("/nonexistent/path/db.sqlite");
    // Don't call init() — simulate DB unavailable
    const result = badRepo.save(makeOutcome());
    expect(result).toBe(false);
    expect(badRepo.getLatest("board.health")).toBeNull();
  });
});

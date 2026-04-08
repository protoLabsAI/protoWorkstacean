import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CeremonyYamlLoader } from "../ceremonyYamlLoader.ts";

const TEST_DIR = join(import.meta.dir, ".test-workspace-loader");

function setupWorkspace() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "ceremonies"), { recursive: true });
}

function cleanupWorkspace() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

describe("CeremonyYamlLoader", () => {
  let loader: CeremonyYamlLoader;

  beforeEach(() => {
    setupWorkspace();
    loader = new CeremonyYamlLoader(TEST_DIR);
  });

  afterEach(() => {
    cleanupWorkspace();
  });

  test("returns empty array when ceremonies dir does not exist", () => {
    const loader2 = new CeremonyYamlLoader(join(TEST_DIR, "nonexistent"));
    const ceremonies = loader2.loadGlobal();
    expect(ceremonies).toEqual([]);
  });

  test("returns empty array when ceremonies dir is empty", () => {
    const ceremonies = loader.loadGlobal();
    expect(ceremonies).toEqual([]);
  });

  test("loads a valid ceremony YAML file", () => {
    writeFileSync(
      join(TEST_DIR, "ceremonies", "board.health.yaml"),
      `id: board.health
name: Board Health Check
schedule: "*/30 * * * *"
skill: board_health
targets:
  - all
enabled: true
`
    );

    const ceremonies = loader.loadGlobal();
    expect(ceremonies).toHaveLength(1);
    expect(ceremonies[0]!.id).toBe("board.health");
    expect(ceremonies[0]!.name).toBe("Board Health Check");
    expect(ceremonies[0]!.schedule).toBe("*/30 * * * *");
    expect(ceremonies[0]!.skill).toBe("board_health");
    expect(ceremonies[0]!.targets).toEqual(["all"]);
    expect(ceremonies[0]!.enabled).toBe(true);
  });

  test("loads multiple ceremony YAML files", () => {
    writeFileSync(
      join(TEST_DIR, "ceremonies", "board.health.yaml"),
      `id: board.health
name: Board Health
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: true
`
    );
    writeFileSync(
      join(TEST_DIR, "ceremonies", "board.retro.yaml"),
      `id: board.retro
name: Weekly Retro
schedule: "0 9 * * 1"
skill: pattern_mining
targets: [all]
enabled: true
`
    );

    const ceremonies = loader.loadGlobal();
    expect(ceremonies).toHaveLength(2);
    const ids = ceremonies.map((c) => c.id).sort();
    expect(ids).toEqual(["board.health", "board.retro"]);
  });

  test("skips ceremony with missing id", () => {
    writeFileSync(
      join(TEST_DIR, "ceremonies", "bad.yaml"),
      `name: No ID
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: true
`
    );
    const ceremonies = loader.loadGlobal();
    expect(ceremonies).toHaveLength(0);
  });

  test("skips ceremony with missing skill", () => {
    writeFileSync(
      join(TEST_DIR, "ceremonies", "bad.yaml"),
      `id: missing.skill
name: Missing Skill
schedule: "*/30 * * * *"
targets: [all]
enabled: true
`
    );
    const ceremonies = loader.loadGlobal();
    expect(ceremonies).toHaveLength(0);
  });

  test("skips ceremony with empty targets", () => {
    writeFileSync(
      join(TEST_DIR, "ceremonies", "bad.yaml"),
      `id: empty.targets
name: Empty Targets
schedule: "*/30 * * * *"
skill: board_health
targets: []
enabled: true
`
    );
    const ceremonies = loader.loadGlobal();
    expect(ceremonies).toHaveLength(0);
  });

  test("defaults enabled to true when not specified", () => {
    writeFileSync(
      join(TEST_DIR, "ceremonies", "board.health.yaml"),
      `id: board.health
name: Board Health
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
`
    );

    const ceremonies = loader.loadGlobal();
    expect(ceremonies[0]!.enabled).toBe(true);
  });

  test("respects enabled: false", () => {
    writeFileSync(
      join(TEST_DIR, "ceremonies", "board.health.yaml"),
      `id: board.health
name: Board Health
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: false
`
    );

    const ceremonies = loader.loadGlobal();
    expect(ceremonies[0]!.enabled).toBe(false);
  });

  test("loads notifyChannel when present", () => {
    writeFileSync(
      join(TEST_DIR, "ceremonies", "board.health.yaml"),
      `id: board.health
name: Board Health
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
notifyChannel: general
enabled: true
`
    );

    const ceremonies = loader.loadGlobal();
    expect(ceremonies[0]!.notifyChannel).toBe("general");
  });

  test("loadMerged returns global ceremonies when no project slug given", () => {
    writeFileSync(
      join(TEST_DIR, "ceremonies", "board.health.yaml"),
      `id: board.health
name: Board Health
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: true
`
    );

    const result = loader.loadMerged();
    expect(result.source).toBe("global");
    expect(result.ceremonies).toHaveLength(1);
  });

  test("project ceremonies override global ceremonies with same ID", () => {
    // Global
    writeFileSync(
      join(TEST_DIR, "ceremonies", "board.health.yaml"),
      `id: board.health
name: Global Health
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: true
`
    );

    // Project override
    const projectDir = join(TEST_DIR, "..", ".automaker", "projects", "my-project", "ceremonies");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "board.health.yaml"),
      `id: board.health
name: Project Health Override
schedule: "*/5 * * * *"
skill: board_health
targets: [my-project]
enabled: true
`
    );

    const loader2 = new CeremonyYamlLoader(TEST_DIR);
    const result = loader2.loadMerged("my-project");
    expect(result.source).toBe("merged");

    const ceremony = result.ceremonies.find((c) => c.id === "board.health");
    expect(ceremony).toBeDefined();
    expect(ceremony!.name).toBe("Project Health Override");
    expect(ceremony!.schedule).toBe("*/5 * * * *");
    expect(ceremony!.targets).toEqual(["my-project"]);

    // Cleanup project dir
    rmSync(join(TEST_DIR, "..", ".automaker"), { recursive: true, force: true });
  });

  test("skips invalid YAML files without crashing", () => {
    writeFileSync(
      join(TEST_DIR, "ceremonies", "bad.yaml"),
      `[invalid yaml: {{{{`
    );
    writeFileSync(
      join(TEST_DIR, "ceremonies", "good.yaml"),
      `id: good.ceremony
name: Good Ceremony
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: true
`
    );

    const ceremonies = loader.loadGlobal();
    expect(ceremonies).toHaveLength(1);
    expect(ceremonies[0]!.id).toBe("good.ceremony");
  });
});

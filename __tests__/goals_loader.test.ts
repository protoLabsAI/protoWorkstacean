import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GoalsLoader } from "../src/loaders/goals_loader.ts";

const TMP_DIR = join(process.cwd(), "tmp", "test-goals-loader");

function setup() {
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(join(TMP_DIR, "workspace"), { recursive: true });
}

function teardown() {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

describe("GoalsLoader", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("loads global goals from workspace/goals.yaml", () => {
    const goalsYaml = `
version: "1.0"
goals:
  - id: test-invariant
    type: Invariant
    description: Test invariant goal
    selector: status
    operator: truthy
  - id: test-threshold
    type: Threshold
    description: Test threshold goal
    selector: metrics.cpu
    max: 80
`;
    writeFileSync(join(TMP_DIR, "workspace", "goals.yaml"), goalsYaml);
    const loader = new GoalsLoader(join(TMP_DIR, "workspace"));
    const goals = loader.loadGlobal();

    expect(goals).toHaveLength(2);
    expect(goals[0].id).toBe("test-invariant");
    expect(goals[0].type).toBe("Invariant");
    expect(goals[1].id).toBe("test-threshold");
    expect(goals[1].type).toBe("Threshold");
  });

  test("returns empty array when global goals.yaml is missing", () => {
    const loader = new GoalsLoader(join(TMP_DIR, "workspace"));
    const goals = loader.loadGlobal();
    expect(goals).toHaveLength(0);
  });

  test("skips invalid goals and continues with valid ones", () => {
    const goalsYaml = `
goals:
  - id: valid-goal
    type: Invariant
    description: Valid goal
    selector: status
  - type: Invariant
    description: Missing ID — invalid
    selector: foo
  - id: no-type-goal
    description: Missing type — invalid
    selector: bar
`;
    writeFileSync(join(TMP_DIR, "workspace", "goals.yaml"), goalsYaml);
    const loader = new GoalsLoader(join(TMP_DIR, "workspace"));
    const goals = loader.loadGlobal();

    expect(goals).toHaveLength(1);
    expect(goals[0].id).toBe("valid-goal");
  });

  test("applies project overrides to global goals", () => {
    const globalYaml = `
goals:
  - id: shared-goal
    type: Invariant
    description: Global version
    selector: status
    operator: truthy
  - id: global-only
    type: Threshold
    description: Only in global
    selector: cpu
    max: 80
`;
    const projectYaml = `
goals:
  - id: shared-goal
    type: Invariant
    description: Project override version
    selector: status
    operator: eq
    expected: "healthy"
  - id: project-only
    type: Threshold
    description: Only in project
    selector: memory
    max: 90
`;
    writeFileSync(join(TMP_DIR, "workspace", "goals.yaml"), globalYaml);
    const projectDir = join(TMP_DIR, "projects", "my-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "goals.yaml"), projectYaml);

    const loader = new GoalsLoader(join(TMP_DIR, "workspace"), join(TMP_DIR, "projects"));
    const result = loader.loadMerged("my-project");

    expect(result.source).toBe("merged");
    expect(result.projectSlug).toBe("my-project");

    const sharedGoal = result.goals.find(g => g.id === "shared-goal");
    expect(sharedGoal).toBeDefined();
    expect(sharedGoal!.description).toBe("Project override version");

    const globalOnly = result.goals.find(g => g.id === "global-only");
    expect(globalOnly).toBeDefined();

    const projectOnly = result.goals.find(g => g.id === "project-only");
    expect(projectOnly).toBeDefined();
  });

  test("returns global goals when project has no goals.yaml", () => {
    const globalYaml = `
goals:
  - id: global-goal
    type: Invariant
    description: Global goal
    selector: status
`;
    writeFileSync(join(TMP_DIR, "workspace", "goals.yaml"), globalYaml);

    const loader = new GoalsLoader(join(TMP_DIR, "workspace"), join(TMP_DIR, "projects"));
    const result = loader.loadMerged("nonexistent-project");

    expect(result.source).toBe("global");
    expect(result.goals).toHaveLength(1);
  });

  test("handles malformed YAML gracefully", () => {
    writeFileSync(join(TMP_DIR, "workspace", "goals.yaml"), "{ invalid yaml: [[[");
    const loader = new GoalsLoader(join(TMP_DIR, "workspace"));
    const goals = loader.loadGlobal();
    expect(goals).toHaveLength(0);
  });
});

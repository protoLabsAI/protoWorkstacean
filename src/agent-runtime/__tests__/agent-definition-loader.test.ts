import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { parseAgentYaml, loadAgentDefinitions } from "../agent-definition-loader.ts";
import type { RawAgentYaml } from "../types.ts";

// ── parseAgentYaml ────────────────────────────────────────────────────────────

describe("parseAgentYaml", () => {
  const validRaw: RawAgentYaml = {
    name: "ava",
    role: "orchestrator",
    model: "claude-opus-4-6",
    systemPrompt: "You are Ava.",
    tools: ["get_world_state", "publish_event"],
    canDelegate: ["quinn"],
    maxTurns: 15,
    skills: [
      { name: "plan", description: "Create a plan" },
      { name: "sitrep" },
    ],
  };

  test("parses a complete valid definition", () => {
    const def = parseAgentYaml(validRaw, "ava.yaml");
    expect(def.name).toBe("ava");
    expect(def.role).toBe("orchestrator");
    expect(def.model).toBe("claude-opus-4-6");
    expect(def.tools).toEqual(["get_world_state", "publish_event"]);
    expect(def.canDelegate).toEqual(["quinn"]);
    expect(def.maxTurns).toBe(15);
    expect(def.skills).toHaveLength(2);
    expect(def.skills[0]).toEqual({ name: "plan", description: "Create a plan" });
    expect(def.skills[1]).toEqual({ name: "sitrep" });
  });

  test("throws on missing name", () => {
    expect(() =>
      parseAgentYaml({ ...validRaw, name: undefined }, "x.yaml"),
    ).toThrow(/Missing or invalid 'name'/);
  });

  test("throws on missing model", () => {
    expect(() =>
      parseAgentYaml({ ...validRaw, model: undefined }, "x.yaml"),
    ).toThrow(/Missing or invalid 'model'/);
  });

  test("throws on invalid role", () => {
    expect(() =>
      parseAgentYaml({ ...validRaw, role: "ninja" }, "x.yaml"),
    ).toThrow(/Invalid 'role'/);
  });

  test("throws on missing systemPrompt", () => {
    expect(() =>
      parseAgentYaml({ ...validRaw, systemPrompt: undefined }, "x.yaml"),
    ).toThrow(/Missing or invalid 'systemPrompt'/);
  });

  test("defaults maxTurns to 10 when missing", () => {
    const def = parseAgentYaml({ ...validRaw, maxTurns: undefined }, "x.yaml");
    expect(def.maxTurns).toBe(10);
  });

  test("defaults maxTurns to 10 when 0 or negative", () => {
    expect(parseAgentYaml({ ...validRaw, maxTurns: 0 }, "x.yaml").maxTurns).toBe(10);
    expect(parseAgentYaml({ ...validRaw, maxTurns: -5 }, "x.yaml").maxTurns).toBe(10);
  });

  test("tools defaults to empty array when missing", () => {
    const def = parseAgentYaml({ ...validRaw, tools: undefined }, "x.yaml");
    expect(def.tools).toEqual([]);
  });

  test("skills defaults to empty array when missing", () => {
    const def = parseAgentYaml({ ...validRaw, skills: undefined }, "x.yaml");
    expect(def.skills).toEqual([]);
  });

  test("skills filters out entries without name", () => {
    const def = parseAgentYaml(
      { ...validRaw, skills: [{ name: "plan" }, { description: "no name" }] },
      "x.yaml",
    );
    expect(def.skills).toHaveLength(1);
    expect(def.skills[0].name).toBe("plan");
  });

  test("parses hitlMode on a skill", () => {
    const def = parseAgentYaml(
      { ...validRaw, skills: [{ name: "chat", hitlMode: "notification" }] },
      "x.yaml",
    );
    expect(def.skills[0].hitlMode).toBe("notification");
  });

  test("all valid hitlMode values are accepted", () => {
    const modes = ["autonomous", "notification", "veto", "gated", "compound"] as const;
    for (const mode of modes) {
      const def = parseAgentYaml(
        { ...validRaw, skills: [{ name: "test", hitlMode: mode }] },
        "x.yaml",
      );
      expect(def.skills[0].hitlMode).toBe(mode);
    }
  });

  test("invalid hitlMode is ignored (field omitted)", () => {
    const def = parseAgentYaml(
      { ...validRaw, skills: [{ name: "chat", hitlMode: "superautonomous" }] },
      "x.yaml",
    );
    expect(def.skills[0].hitlMode).toBeUndefined();
  });

  test("missing hitlMode is undefined", () => {
    const def = parseAgentYaml(
      { ...validRaw, skills: [{ name: "chat" }] },
      "x.yaml",
    );
    expect(def.skills[0].hitlMode).toBeUndefined();
  });

  test("canDelegate is undefined when not provided", () => {
    const def = parseAgentYaml({ ...validRaw, canDelegate: undefined }, "x.yaml");
    expect(def.canDelegate).toBeUndefined();
  });

  test("all valid roles are accepted", () => {
    const roles = ["orchestrator", "qa", "devops", "content", "research", "general"] as const;
    for (const role of roles) {
      const def = parseAgentYaml({ ...validRaw, role }, "x.yaml");
      expect(def.role).toBe(role);
    }
  });
});

// ── loadAgentDefinitions ──────────────────────────────────────────────────────

describe("loadAgentDefinitions", () => {
  /** Create a temp workspace directory with optional agents. */
  function makeTempWorkspace(
    agents: Record<string, object>,
  ): { workspaceDir: string; cleanup: () => void } {
    const workspaceDir = join(tmpdir(), `workstacean-test-${crypto.randomUUID()}`);
    const agentsDir = join(workspaceDir, "agents");
    mkdirSync(agentsDir, { recursive: true });

    for (const [filename, data] of Object.entries(agents)) {
      writeFileSync(join(agentsDir, filename), stringifyYaml(data), "utf8");
    }

    return {
      workspaceDir,
      cleanup: () => rmSync(workspaceDir, { recursive: true, force: true }),
    };
  }

  const validAgent = {
    name: "quinn",
    role: "qa",
    model: "claude-sonnet-4-6",
    systemPrompt: "You are Quinn.",
    tools: [],
    skills: [{ name: "bug_triage" }],
  };

  test("returns empty array when workspace/agents/ does not exist", () => {
    const ws = join(tmpdir(), `no-agents-${crypto.randomUUID()}`);
    mkdirSync(ws, { recursive: true });
    const defs = loadAgentDefinitions(ws);
    expect(defs).toEqual([]);
    rmSync(ws, { recursive: true, force: true });
  });

  test("loads a valid agent YAML file", () => {
    const { workspaceDir, cleanup } = makeTempWorkspace({ "quinn.yaml": validAgent });
    try {
      const defs = loadAgentDefinitions(workspaceDir);
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe("quinn");
      expect(defs[0].skills[0].name).toBe("bug_triage");
    } finally {
      cleanup();
    }
  });

  test("loads multiple agent files", () => {
    const { workspaceDir, cleanup } = makeTempWorkspace({
      "quinn.yaml": validAgent,
      "frank.yaml": { ...validAgent, name: "frank", role: "devops" },
    });
    try {
      const defs = loadAgentDefinitions(workspaceDir);
      expect(defs).toHaveLength(2);
      expect(defs.map(d => d.name).sort()).toEqual(["frank", "quinn"]);
    } finally {
      cleanup();
    }
  });

  test("skips *.example files", () => {
    const { workspaceDir, cleanup } = makeTempWorkspace({
      "quinn.yaml": validAgent,
      "ava.yaml.example": { ...validAgent, name: "ava-example" },
    });
    try {
      const defs = loadAgentDefinitions(workspaceDir);
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe("quinn");
    } finally {
      cleanup();
    }
  });

  test("skips invalid files without throwing", () => {
    const { workspaceDir, cleanup } = makeTempWorkspace({
      "quinn.yaml": validAgent,
      "broken.yaml": { name: "broken" /* missing required fields */ },
    });
    try {
      const defs = loadAgentDefinitions(workspaceDir);
      // Only the valid one loaded
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe("quinn");
    } finally {
      cleanup();
    }
  });

  test("handles empty agents directory", () => {
    const { workspaceDir, cleanup } = makeTempWorkspace({});
    try {
      const defs = loadAgentDefinitions(workspaceDir);
      expect(defs).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

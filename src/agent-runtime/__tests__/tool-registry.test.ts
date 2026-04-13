import { describe, test, expect, beforeEach } from "bun:test";
import { ToolRegistry } from "../tool-registry.ts";
import { tool } from "@protolabsai/sdk";
import { z } from "zod";

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeTool = (name: string) =>
  tool(
    name,
    `${name} tool`,
    { input: z.string() },
    async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  );

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  test("starts empty", () => {
    expect(registry.size).toBe(0);
    expect(registry.names()).toEqual([]);
    expect(registry.all()).toEqual([]);
  });

  test("register() adds a tool", () => {
    registry.register(makeTool("alpha"));
    expect(registry.size).toBe(1);
    expect(registry.names()).toEqual(["alpha"]);
  });

  test("register() overwrites a tool with the same name", () => {
    const first = makeTool("alpha");
    const second = tool(
      "alpha",
      "overwritten",
      { n: z.number() },
      async () => ({ content: [{ type: "text" as const, text: "v2" }] }),
    );
    registry.register(first);
    registry.register(second);
    expect(registry.size).toBe(1);
    expect(registry.get("alpha")?.description).toBe("overwritten");
  });

  test("registerAll() adds multiple tools", () => {
    registry.registerAll([makeTool("a"), makeTool("b"), makeTool("c")]);
    expect(registry.size).toBe(3);
    expect(registry.names().sort()).toEqual(["a", "b", "c"]);
  });

  test("get() returns correct tool by name", () => {
    const t = makeTool("target");
    registry.register(t);
    expect(registry.get("target")).toBe(t);
  });

  test("get() returns undefined for unknown name", () => {
    expect(registry.get("nope")).toBeUndefined();
  });

  test("forAgent() returns only whitelisted tools", () => {
    registry.registerAll([makeTool("a"), makeTool("b"), makeTool("c")]);
    const filtered = registry.forAgent(["a", "c"]);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(t => t.name).sort()).toEqual(["a", "c"]);
  });

  test("forAgent() silently skips unknown names", () => {
    registry.register(makeTool("a"));
    const filtered = registry.forAgent(["a", "does-not-exist"]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("a");
  });

  test("forAgent([]) returns empty array", () => {
    registry.registerAll([makeTool("a"), makeTool("b")]);
    expect(registry.forAgent([])).toEqual([]);
  });

  test("all() returns all registered tools", () => {
    registry.registerAll([makeTool("x"), makeTool("y")]);
    expect(registry.all()).toHaveLength(2);
  });

  describe("validateAgentTools()", () => {
    test("returns empty array when all declared tools are known", () => {
      registry.registerAll([makeTool("a"), makeTool("b")]);
      expect(registry.validateAgentTools("my-agent", ["a", "b"])).toEqual([]);
    });

    test("returns unknown tool names", () => {
      registry.register(makeTool("known"));
      const unknowns = registry.validateAgentTools("my-agent", ["known", "missing-1", "missing-2"]);
      expect(unknowns).toEqual(["missing-1", "missing-2"]);
    });

    test("returns empty array for empty declared list", () => {
      registry.register(makeTool("a"));
      expect(registry.validateAgentTools("my-agent", [])).toEqual([]);
    });
  });
});

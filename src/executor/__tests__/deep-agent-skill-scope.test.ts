import { describe, expect, test } from "bun:test";
import { effectiveToolsFor, effectiveMaxTurnsFor, effectiveModelFor } from "../executors/deep-agent-executor.ts";

describe("effectiveToolsFor", () => {
  const agentTools = ["pr_inspector", "create_github_issue", "chat_with_agent", "searxng_search", "react"];

  test("returns agent tools unchanged when skill omits tools", () => {
    expect(effectiveToolsFor(undefined, agentTools)).toEqual(agentTools);
  });

  test("intersects with agent tools when skill declares its own list", () => {
    expect(effectiveToolsFor(["pr_inspector", "react"], agentTools)).toEqual(["pr_inspector", "react"]);
  });

  test("skill cannot grant access to a tool the agent doesn't have", () => {
    expect(effectiveToolsFor(["pr_inspector", "phantom_tool"], agentTools)).toEqual(["pr_inspector"]);
  });

  test("empty skill list yields empty effective list", () => {
    expect(effectiveToolsFor([], agentTools)).toEqual([]);
  });

  test("preserves skill-declared ordering (independent of agent ordering)", () => {
    expect(effectiveToolsFor(["react", "pr_inspector"], agentTools)).toEqual(["react", "pr_inspector"]);
  });

  test("agent with no tools always yields empty regardless of skill", () => {
    expect(effectiveToolsFor(["pr_inspector"], [])).toEqual([]);
    expect(effectiveToolsFor(undefined, [])).toEqual([]);
  });
});

describe("effectiveMaxTurnsFor", () => {
  test("skill override wins when set", () => {
    expect(effectiveMaxTurnsFor(18, 12)).toBe(18);
  });

  test("agent maxTurns is the fallback when skill omits", () => {
    expect(effectiveMaxTurnsFor(undefined, 12)).toBe(12);
  });

  test("skill override of 0 is honored (not treated as falsy)", () => {
    expect(effectiveMaxTurnsFor(0, 12)).toBe(0);
  });
});

describe("effectiveModelFor", () => {
  const defaultModel = "claude-sonnet-4-6";

  test("returns default when payload override is undefined", () => {
    expect(effectiveModelFor(undefined, defaultModel)).toBe(defaultModel);
  });

  test("returns default when payload override is null", () => {
    expect(effectiveModelFor(null, defaultModel)).toBe(defaultModel);
  });

  test("returns default when payload override is a non-string type", () => {
    expect(effectiveModelFor(42, defaultModel)).toBe(defaultModel);
    expect(effectiveModelFor({ foo: "bar" }, defaultModel)).toBe(defaultModel);
  });

  test("returns default when payload override is an empty string", () => {
    expect(effectiveModelFor("", defaultModel)).toBe(defaultModel);
  });

  test("returns default when payload override is whitespace-only", () => {
    expect(effectiveModelFor("   ", defaultModel)).toBe(defaultModel);
    expect(effectiveModelFor("\n\t", defaultModel)).toBe(defaultModel);
  });

  test("returns the override when it's a non-empty string", () => {
    expect(effectiveModelFor("claude-opus-4-7", defaultModel)).toBe("claude-opus-4-7");
  });

  test("trims surrounding whitespace from override", () => {
    expect(effectiveModelFor("  claude-opus-4-7  ", defaultModel)).toBe("claude-opus-4-7");
  });

  test("override identical to default still returns the default value", () => {
    expect(effectiveModelFor(defaultModel, defaultModel)).toBe(defaultModel);
  });
});

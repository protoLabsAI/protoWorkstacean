import { describe, test, expect } from "bun:test";
import { modelToRouting, flattenMessages } from "../openai-compat.ts";

describe("openai-compat — modelToRouting", () => {
  test("bare skill ID → skill, no targets", () => {
    expect(modelToRouting("chat")).toEqual({ skill: "chat", targets: [] });
    expect(modelToRouting("pr_review")).toEqual({ skill: "pr_review", targets: [] });
  });

  test("agent/skill form → skill + target agent", () => {
    expect(modelToRouting("quinn/pr_review")).toEqual({ skill: "pr_review", targets: ["quinn"] });
    expect(modelToRouting("protopen/passive_recon")).toEqual({ skill: "passive_recon", targets: ["protopen"] });
  });

  test("'ava' alias → chat skill on ava", () => {
    expect(modelToRouting("ava")).toEqual({ skill: "chat", targets: ["ava"] });
  });

  test("empty model → default chat", () => {
    expect(modelToRouting("")).toEqual({ skill: "chat", targets: [] });
  });

  test("leading slash does not split", () => {
    expect(modelToRouting("/weird")).toEqual({ skill: "/weird", targets: [] });
  });
});

describe("openai-compat — flattenMessages", () => {
  test("joins all roles with prefixes", () => {
    const prompt = flattenMessages([
      { role: "system", content: "you are a helper" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "what's up?" },
    ]);
    expect(prompt).toContain("[system] you are a helper");
    expect(prompt).toContain("[user] hi");
    expect(prompt).toContain("[assistant] hello");
    expect(prompt).toContain("[user] what's up?");
  });

  test("skips messages with null or empty content", () => {
    const prompt = flattenMessages([
      { role: "user", content: "real" },
      { role: "tool", content: "" },
      { role: "assistant", content: null },
    ]);
    expect(prompt).toBe("[user] real");
  });

  test("tool role is skipped (not a content role for our flow)", () => {
    const prompt = flattenMessages([
      { role: "user", content: "u" },
      { role: "tool", content: "some tool output" },
    ]);
    expect(prompt).not.toContain("tool output");
  });
});

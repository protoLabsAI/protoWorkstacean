import { describe, expect, test } from "bun:test";
import { extractAiText } from "../executors/deep-agent-executor.ts";

describe("extractAiText", () => {
  test("returns trimmed string content as-is", () => {
    expect(extractAiText("  hello world  ")).toBe("hello world");
  });

  test("returns empty string for null, undefined, number, boolean, plain object", () => {
    expect(extractAiText(null)).toBe("");
    expect(extractAiText(undefined)).toBe("");
    expect(extractAiText(42)).toBe("");
    expect(extractAiText(true)).toBe("");
    expect(extractAiText({})).toBe("");
  });

  test("extracts text from a single text-type block", () => {
    expect(extractAiText([{ type: "text", text: "PR looks good." }])).toBe("PR looks good.");
  });

  test("skips thinking blocks and returns only text blocks (reasoning-model shape)", () => {
    const content = [
      { type: "thinking", thinking: "Let me check the CI..." },
      { type: "text", text: "VERDICT: PASS — CI is green." },
    ];
    expect(extractAiText(content)).toBe("VERDICT: PASS — CI is green.");
  });

  test("concatenates multiple text blocks in order", () => {
    const content = [
      { type: "text", text: "Part 1. " },
      { type: "thinking", thinking: "..." },
      { type: "text", text: "Part 2." },
    ];
    expect(extractAiText(content)).toBe("Part 1. Part 2.");
  });

  test("ignores unknown block types", () => {
    const content = [
      { type: "image", url: "..." },
      { type: "text", text: "only this" },
      { type: "tool_use", id: "abc", name: "x" },
    ];
    expect(extractAiText(content)).toBe("only this");
  });

  test("returns empty string when no text blocks present (all thinking / tool calls)", () => {
    const content = [
      { type: "thinking", thinking: "..." },
      { type: "tool_use", id: "abc", name: "pr_inspector" },
    ];
    expect(extractAiText(content)).toBe("");
  });

  test("accepts string entries inside an array", () => {
    expect(extractAiText(["hello ", "world"])).toBe("hello world");
  });
});

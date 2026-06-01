/**
 * McpExecutor argument/result mapping (ADR-0005 P4) — the pure glue between a
 * skill request and an MCP callTool.
 */

import { describe, test, expect } from "bun:test";
import { toToolArguments, flattenToolContent } from "../mcp-executor.ts";

describe("toToolArguments", () => {
  test("a JSON object is used as the tool arguments verbatim", () => {
    expect(toToolArguments('{"path":"/x","depth":2}')).toEqual({ path: "/x", depth: 2 });
  });
  test("non-JSON / scalar content is wrapped under `input` (simple single-arg tools)", () => {
    expect(toToolArguments("just some text")).toEqual({ input: "just some text" });
    expect(toToolArguments("42")).toEqual({ input: "42" }); // a bare number isn't an object
    expect(toToolArguments('["a","b"]')).toEqual({ input: '["a","b"]' }); // arrays aren't arg objects
  });
  test("empty / undefined content → no arguments", () => {
    expect(toToolArguments("")).toEqual({});
    expect(toToolArguments(undefined)).toEqual({});
  });
});

describe("flattenToolContent", () => {
  test("joins text parts; labels non-text parts", () => {
    expect(flattenToolContent([
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ])).toBe("line one\nline two");
    expect(flattenToolContent([{ type: "image", mimeType: "image/png", data: "..." }])).toBe("[image image/png]");
  });
  test("tolerates non-array / empty content", () => {
    expect(flattenToolContent(undefined)).toBe("");
    expect(flattenToolContent([])).toBe("");
  });
});

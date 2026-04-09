import { describe, test, expect } from "bun:test";
import { StateDiffEngine, resolvePath } from "../src/engines/state_diff_engine.ts";

describe("resolvePath", () => {
  test("resolves top-level key", () => {
    const result = resolvePath({ status: "ok" }, "status");
    expect(result.found).toBe(true);
    expect(result.value).toBe("ok");
  });

  test("resolves nested key", () => {
    const result = resolvePath({ a: { b: { c: 42 } } }, "a.b.c");
    expect(result.found).toBe(true);
    expect(result.value).toBe(42);
  });

  test("returns not found for missing key", () => {
    const result = resolvePath({ a: 1 }, "a.b.c");
    expect(result.found).toBe(false);
  });

  test("returns not found for null intermediate", () => {
    const result = resolvePath({ a: null }, "a.b");
    expect(result.found).toBe(false);
  });

  test("resolves empty path returning whole object", () => {
    const obj = { x: 1 };
    const result = resolvePath(obj, "");
    expect(result.found).toBe(true);
    expect(result.value).toBe(obj);
  });
});

describe("StateDiffEngine", () => {
  const engine = new StateDiffEngine();

  test("returns no diff for identical states", () => {
    const state = { a: 1, b: "hello" };
    const diff = engine.diff(state, state);
    expect(diff.hasChanges).toBe(false);
    expect(diff.entries).toHaveLength(0);
  });

  test("diffs state — detects changed value", () => {
    const expected = { status: "ok" };
    const actual = { status: "error" };
    const diff = engine.diff(expected, actual);

    expect(diff.hasChanges).toBe(true);
    const entry = diff.entries.find(e => e.path === "status");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("changed");
    expect(entry!.expected).toBe("ok");
    expect(entry!.actual).toBe("error");
  });

  test("detects missing field", () => {
    const expected = { a: 1, b: 2 };
    const actual = { a: 1 };
    const diff = engine.diff(expected, actual);

    expect(diff.hasChanges).toBe(true);
    const entry = diff.entries.find(e => e.path === "b");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("missing");
  });

  test("detects extra field", () => {
    const expected = { a: 1 };
    const actual = { a: 1, b: 2 };
    const diff = engine.diff(expected, actual);

    expect(diff.hasChanges).toBe(true);
    const entry = diff.entries.find(e => e.path === "b");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("extra");
  });

  test("detects type mismatch", () => {
    const expected = { count: 5 };
    const actual = { count: "5" };
    const diff = engine.diff(expected, actual);

    expect(diff.hasChanges).toBe(true);
    const entry = diff.entries.find(e => e.path === "count");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("type_mismatch");
  });

  test("recursively diffs nested objects", () => {
    const expected = { a: { b: { c: 1 } } };
    const actual = { a: { b: { c: 2 } } };
    const diff = engine.diff(expected, actual);

    expect(diff.hasChanges).toBe(true);
    const entry = diff.entries.find(e => e.path === "a.b.c");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("changed");
  });

  test("detects array changes", () => {
    const expected = { items: [1, 2, 3] };
    const actual = { items: [1, 2, 4] };
    const diff = engine.diff(expected, actual);

    expect(diff.hasChanges).toBe(true);
  });
});

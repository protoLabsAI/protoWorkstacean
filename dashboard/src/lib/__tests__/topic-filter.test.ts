import { describe, test, expect } from "bun:test";
import { topicMatchesFilter } from "../topic-filter";

describe("topicMatchesFilter", () => {
  test("empty filter matches everything", () => {
    expect(topicMatchesFilter("agent.task.completed", "")).toBe(true);
    expect(topicMatchesFilter("any.topic", "")).toBe(true);
  });

  test("exact match", () => {
    expect(topicMatchesFilter("agent.task.completed", "agent.task.completed")).toBe(true);
    expect(topicMatchesFilter("agent.task.completed", "agent.task.started")).toBe(false);
  });

  test("* matches single segment", () => {
    expect(topicMatchesFilter("agent.task.completed", "agent.*.completed")).toBe(true);
    expect(topicMatchesFilter("agent.task.completed", "*.task.completed")).toBe(true);
    expect(topicMatchesFilter("agent.task.completed", "agent.*")).toBe(false); // length mismatch
  });

  test("# matches any suffix", () => {
    expect(topicMatchesFilter("agent.task.completed", "agent.#")).toBe(true);
    expect(topicMatchesFilter("agent.task.completed.extra", "agent.#")).toBe(true);
    expect(topicMatchesFilter("agent.task.completed", "#")).toBe(true);
    expect(topicMatchesFilter("agent.task.completed", "other.#")).toBe(false);
  });

  test("combined wildcards", () => {
    expect(topicMatchesFilter("agent.task.completed", "agent.*.*")).toBe(true);
    expect(topicMatchesFilter("debug.info.trace", "debug.#")).toBe(true);
    expect(topicMatchesFilter("agent.task", "agent.*.completed")).toBe(false);
  });

  test("empty topic with non-empty filter", () => {
    expect(topicMatchesFilter("", "agent.task")).toBe(false);
    expect(topicMatchesFilter("", "")).toBe(true);
    expect(topicMatchesFilter("", "#")).toBe(true);
  });

  test("single segment topics", () => {
    expect(topicMatchesFilter("ping", "ping")).toBe(true);
    expect(topicMatchesFilter("ping", "pong")).toBe(false);
    expect(topicMatchesFilter("ping", "*")).toBe(true);
    expect(topicMatchesFilter("ping", "#")).toBe(true);
  });
});

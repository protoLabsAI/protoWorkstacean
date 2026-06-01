/**
 * computeAgentDiff / hashDefinition — agent-definition diffing for hot-reload (ADR-0004 P1).
 */

import { describe, test, expect } from "bun:test";
import { computeAgentDiff, hashDefinition } from "../agent-diff.ts";
import type { AgentDefinition } from "../types.ts";

function def(name: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name,
    role: "general",
    model: "m",
    systemPrompt: "p",
    tools: [],
    skills: [],
    ...extra,
  } as AgentDefinition;
}

describe("computeAgentDiff", () => {
  test("classifies added / changed / removed by name + content hash", () => {
    const registered = new Map([
      ["ava", hashDefinition(def("ava"))],
      ["quinn", hashDefinition(def("quinn"))],
    ]);
    const next = [
      def("ava"),                               // unchanged
      def("quinn", { systemPrompt: "changed" }), // changed
      def("proto"),                              // added
    ];
    const d = computeAgentDiff(registered, next);
    expect(d.added.map((a) => a.name)).toEqual(["proto"]);
    expect(d.changed.map((a) => a.name)).toEqual(["quinn"]);
    expect(d.removed).toEqual([]);
  });

  test("reports removed agents that disappear from disk", () => {
    const registered = new Map([
      ["ava", hashDefinition(def("ava"))],
      ["old", hashDefinition(def("old"))],
    ]);
    const d = computeAgentDiff(registered, [def("ava")]);
    expect(d.removed).toEqual(["old"]);
    expect(d.added).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  test("hashDefinition is stable and sensitive to content", () => {
    expect(hashDefinition(def("ava"))).toBe(hashDefinition(def("ava")));
    expect(hashDefinition(def("ava"))).not.toBe(hashDefinition(def("ava", { model: "other" })));
  });

  test("duplicate agent names — last definition wins", () => {
    const d = computeAgentDiff(new Map(), [def("ava", { model: "a" }), def("ava", { model: "b" })]);
    expect(d.added.length).toBe(1);
    expect(d.added[0]!.model).toBe("b");
  });
});

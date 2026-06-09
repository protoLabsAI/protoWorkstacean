import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseRouteDefinition, routeToYaml, loadRouteEntries } from "../route-definition.ts";

describe("parseRouteDefinition", () => {
  test("accepts a minimal valid route", () => {
    const def = parseRouteDefinition({ name: "triage", when: { topic: "message.inbound.github.#" }, then: { skill: "bug_triage", agent: "quinn" } });
    expect(def.name).toBe("triage");
    expect(def.when.topic).toBe("message.inbound.github.#");
    expect(def.then).toEqual({ skill: "bug_triage", agent: "quinn" });
  });

  test("agent is optional (skill-resolved target)", () => {
    const def = parseRouteDefinition({ name: "r", when: { topic: "x.y" }, then: { skill: "s" } });
    expect(def.then.agent).toBeUndefined();
  });

  test.each([
    ["missing name", { when: { topic: "x.y" }, then: { skill: "s" } }],
    ["bad name", { name: "no spaces", when: { topic: "x.y" }, then: { skill: "s" } }],
    ["missing when.topic", { name: "r", when: {}, then: { skill: "s" } }],
    ["missing then.skill", { name: "r", when: { topic: "x.y" }, then: {} }],
    ["empty agent", { name: "r", when: { topic: "x.y" }, then: { skill: "s", agent: "" } }],
    ["non-boolean enabled", { name: "r", when: { topic: "x.y" }, then: { skill: "s" }, enabled: "yes" }],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseRouteDefinition(raw)).toThrow();
  });

  test.each(["#", "agent.skill.request"])("rejects self-looping trigger %s", (topic) => {
    expect(() => parseRouteDefinition({ name: "loop", when: { topic }, then: { skill: "s" } })).toThrow(/loop/);
  });

  test("round-trips through YAML", () => {
    const def = parseRouteDefinition({ name: "r", description: "d", when: { topic: "x.y" }, then: { skill: "s", agent: "a" }, enabled: false });
    const reparsed = parseRouteDefinition(parseYaml(routeToYaml(def)));
    expect(reparsed).toEqual(def);
  });
});

describe("loadRouteEntries", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "routes-"));
    mkdirSync(join(dir, "routes.d"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("loads valid routes, sorted by name, skipping malformed", () => {
    const rd = join(dir, "routes.d");
    writeFileSync(join(rd, "b.yaml"), "name: bravo\nwhen: { topic: x.y }\nthen: { skill: s }\n");
    writeFileSync(join(rd, "a.yaml"), "name: alpha\nwhen: { topic: x.z }\nthen: { skill: t }\n");
    writeFileSync(join(rd, "bad.yaml"), "name: nope\nthen: { skill: s }\n"); // missing when.topic
    const skips: string[] = [];
    const routes = loadRouteEntries(rd, (file) => skips.push(file));
    expect(routes.map((r) => r.name)).toEqual(["alpha", "bravo"]);
    expect(skips).toEqual(["bad.yaml"]);
  });

  test("absent directory → empty", () => {
    expect(loadRouteEntries(join(dir, "nope.d"))).toEqual([]);
  });
});

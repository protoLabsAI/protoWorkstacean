import { describe, test, expect } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import { architecturalLayout, COLUMNS } from "../layout.ts";

function pluginNode(name: string): Node {
  return { id: `plugin-${name}`, position: { x: 0, y: 0 }, data: { label: name } };
}

function agentNode(name: string): Node {
  return { id: `agent-${name}`, type: "agent", position: { x: 0, y: 0 }, data: { label: name } };
}

function serviceNode(id: string): Node {
  return { id, type: "service", position: { x: 0, y: 0 }, data: { label: id } };
}

describe("architecturalLayout", () => {
  test("assigns column-based x coordinates left-to-right along the spine", () => {
    const nodes: Node[] = [
      pluginNode("debug"),       // system    — leftmost
      pluginNode("github"),      // surface
      pluginNode("router"),      // router
      pluginNode("skill-dispatcher"), // dispatcher
      pluginNode("agent-runtime"),    // executor
      agentNode("quinn"),        // agent
      serviceNode("svc-litellm"),     // service   — rightmost
    ];
    const { nodes: out } = architecturalLayout(nodes, []);
    const x = (id: string) => out.find(n => n.id === id)!.position.x;

    expect(x("plugin-debug")).toBeLessThan(x("plugin-github"));
    expect(x("plugin-github")).toBeLessThan(x("plugin-router"));
    expect(x("plugin-router")).toBeLessThan(x("plugin-skill-dispatcher"));
    expect(x("plugin-skill-dispatcher")).toBeLessThan(x("plugin-agent-runtime"));
    expect(x("plugin-agent-runtime")).toBeLessThan(x("agent-quinn"));
    expect(x("agent-quinn")).toBeLessThan(x("svc-litellm"));
  });

  test("nodes in the same column share an x and stack vertically", () => {
    const nodes: Node[] = [
      pluginNode("github"),
      pluginNode("linear"),
      pluginNode("discord"),
    ];
    const { nodes: out } = architecturalLayout(nodes, []);
    const xs = new Set(out.map(n => n.position.x));
    expect(xs.size).toBe(1); // all surface column

    const ys = out.map(n => n.position.y).sort((a, b) => a - b);
    expect(ys[0]).not.toBe(ys[1]);
    expect(ys[1]).not.toBe(ys[2]);
  });

  test("api-routes pseudo-node lands in the surface column", () => {
    const nodes: Node[] = [
      { id: "api-routes", position: { x: 0, y: 0 }, data: { label: "api-routes" } },
      pluginNode("github"),
    ];
    const { nodes: out } = architecturalLayout(nodes, []);
    const api = out.find(n => n.id === "api-routes")!;
    const gh  = out.find(n => n.id === "plugin-github")!;
    expect(api.position.x).toBe(gh.position.x);
  });

  test("unknown plugin name falls into misc column (rightmost)", () => {
    const nodes: Node[] = [
      pluginNode("brand-new-plugin-no-classification"),
      pluginNode("router"),
    ];
    const { nodes: out } = architecturalLayout(nodes, []);
    const unknown = out.find(n => n.id === "plugin-brand-new-plugin-no-classification")!;
    const router  = out.find(n => n.id === "plugin-router")!;
    expect(unknown.position.x).toBeGreaterThan(router.position.x);
  });

  test("columns array exposes the ordered spine", () => {
    expect(COLUMNS[0]).toBe("system");
    expect(COLUMNS[COLUMNS.length - 1]).toBe("misc");
    expect(COLUMNS.includes("agent")).toBe(true);
  });

  test("preserves edges array unchanged", () => {
    const edges: Edge[] = [{ id: "a-b", source: "x", target: "y" }];
    const out = architecturalLayout([pluginNode("router")], edges);
    expect(out.edges).toBe(edges);
  });
});

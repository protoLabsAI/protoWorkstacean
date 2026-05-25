import { describe, test, expect } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import { dagreLayout } from "../layout.ts";

describe("dagreLayout", () => {
  test("assigns non-placeholder positions to every node", () => {
    const nodes: Node[] = [
      { id: "a", position: { x: 0, y: 0 }, data: { label: "a" } },
      { id: "b", position: { x: 0, y: 0 }, data: { label: "b" } },
      { id: "c", position: { x: 0, y: 0 }, data: { label: "c" } },
    ];
    const edges: Edge[] = [
      { id: "a-b", source: "a", target: "b" },
      { id: "b-c", source: "b", target: "c" },
    ];

    const { nodes: out, edges: outEdges } = dagreLayout(nodes, edges);
    expect(out).toHaveLength(3);
    expect(outEdges).toBe(edges);
    // Default LR direction: x grows along the chain a → b → c.
    const byId = Object.fromEntries(out.map(n => [n.id, n.position]));
    expect(byId.a!.x).toBeLessThan(byId.b!.x);
    expect(byId.b!.x).toBeLessThan(byId.c!.x);
  });

  test("respects node `type` for sizing — agent nodes are wider", () => {
    const nodes: Node[] = [
      { id: "x", type: "agent", position: { x: 0, y: 0 }, data: {} },
      { id: "y", position: { x: 0, y: 0 }, data: {} },
    ];
    const edges: Edge[] = [{ id: "x-y", source: "x", target: "y" }];

    const { nodes: out } = dagreLayout(nodes, edges);
    const xPos = out.find(n => n.id === "x")!.position;
    const yPos = out.find(n => n.id === "y")!.position;
    // Agent node (wider) sits to the left of the plugin pill; in LR layout
    // its right edge sets where the next column starts, so the gap between
    // x.x and y.x should exceed the smaller-node width (160) by the
    // rankSep amount.
    expect(yPos.x - xPos.x).toBeGreaterThan(160);
  });

  test("handles disconnected components", () => {
    const nodes: Node[] = [
      { id: "lone1", position: { x: 0, y: 0 }, data: {} },
      { id: "lone2", position: { x: 0, y: 0 }, data: {} },
    ];
    const { nodes: out } = dagreLayout(nodes, []);
    expect(out).toHaveLength(2);
    // Both nodes get real positions even with no edges to constrain them.
    expect(out.every(n => Number.isFinite(n.position.x))).toBe(true);
    expect(out.every(n => Number.isFinite(n.position.y))).toBe(true);
  });

  test("TB direction grows downward, not rightward", () => {
    const nodes: Node[] = [
      { id: "top", position: { x: 0, y: 0 }, data: {} },
      { id: "bot", position: { x: 0, y: 0 }, data: {} },
    ];
    const edges: Edge[] = [{ id: "t-b", source: "top", target: "bot" }];
    const { nodes: out } = dagreLayout(nodes, edges, { direction: "TB" });
    const t = out.find(n => n.id === "top")!.position;
    const b = out.find(n => n.id === "bot")!.position;
    expect(b.y).toBeGreaterThan(t.y);
  });
});

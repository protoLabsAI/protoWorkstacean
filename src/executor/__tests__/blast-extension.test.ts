import { describe, test, expect, beforeEach } from "bun:test";
import {
  BlastRegistry,
  registerBlastExtension,
  BLAST_URI,
  BLAST_ORDER,
  type BlastRadius,
} from "../extensions/blast.ts";
import { defaultExtensionRegistry } from "../extension-registry.ts";
import type { ExtensionContext } from "../extension-registry.ts";

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    agentName: "quinn",
    skill: "pr_review",
    correlationId: "corr-1",
    metadata: {},
    ...overrides,
  };
}

describe("BlastRegistry", () => {
  test("stores and retrieves declarations by (agent, skill)", () => {
    const r = new BlastRegistry();
    r.declare({ agentName: "quinn", skill: "pr_review", radius: "repo" });
    expect(r.get("quinn", "pr_review")?.radius).toBe("repo");
    expect(r.get("quinn", "other")).toBeUndefined();
  });

  test("compare() orders radii self < project < repo < fleet < public", () => {
    const r = new BlastRegistry();
    expect(r.compare("self", "project")).toBeLessThan(0);
    expect(r.compare("fleet", "repo")).toBeGreaterThan(0);
    expect(r.compare("public", "public")).toBe(0);
    expect(r.compare(undefined, undefined)).toBe(0);
    // Unknown defaults to self — project > unknown
    expect(r.compare(undefined, "project")).toBeLessThan(0);
  });

  test("BLAST_ORDER is monotone increasing", () => {
    const order: BlastRadius[] = ["self", "project", "repo", "fleet", "public"];
    for (let i = 1; i < order.length; i++) {
      expect(BLAST_ORDER[order[i]]).toBeGreaterThan(BLAST_ORDER[order[i - 1]]);
    }
  });

  test("all() enumerates declarations", () => {
    const r = new BlastRegistry();
    r.declare({ agentName: "quinn", skill: "pr_review", radius: "repo" });
    r.declare({ agentName: "frank", skill: "deploy_prod", radius: "public" });
    const all = r.all();
    expect(all.length).toBe(2);
    expect(all.map(d => d.radius).sort()).toEqual(["public", "repo"]);
  });

  test("clear() empties the registry", () => {
    const r = new BlastRegistry();
    r.declare({ agentName: "a", skill: "s", radius: "self" });
    r.clear();
    expect(r.size).toBe(0);
  });
});

describe("blast-v1 extension interceptor", () => {
  let registry: BlastRegistry;

  beforeEach(() => {
    registry = new BlastRegistry();
    registerBlastExtension(registry);
  });

  test("registered on defaultExtensionRegistry", () => {
    const uris = defaultExtensionRegistry.list().map(e => e.uri);
    expect(uris).toContain(BLAST_URI);
  });

  test("before() stamps x-blast-radius when declared", () => {
    registry.declare({ agentName: "quinn", skill: "pr_review", radius: "repo" });
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === BLAST_URI)?.interceptor;
    const ctx = makeCtx();
    interceptor!.before?.(ctx);
    expect(ctx.metadata["x-blast-radius"]).toBe("repo");
  });

  test("before() no-op when no declaration exists", () => {
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === BLAST_URI)?.interceptor;
    const ctx = makeCtx();
    interceptor!.before?.(ctx);
    expect(ctx.metadata["x-blast-radius"]).toBeUndefined();
  });

  test("after() is not defined — blast is read-side only", () => {
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === BLAST_URI)?.interceptor;
    expect(interceptor?.after).toBeUndefined();
  });
});

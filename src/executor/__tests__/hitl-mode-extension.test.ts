import { describe, test, expect, beforeEach } from "bun:test";
import {
  HitlModeRegistry,
  registerHitlModeExtension,
  HITL_MODE_URI,
  HITL_MODE_ORDER,
  type HitlMode,
} from "../extensions/hitl-mode.ts";
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

describe("HitlModeRegistry", () => {
  test("stores and retrieves declarations", () => {
    const r = new HitlModeRegistry();
    r.declare({ agentName: "quinn", skill: "pr_review", mode: "gated" });
    expect(r.get("quinn", "pr_review")?.mode).toBe("gated");
    expect(r.get("quinn", "other")).toBeUndefined();
  });

  test("resolveMode falls back to autonomous by default", () => {
    const r = new HitlModeRegistry();
    expect(r.resolveMode("quinn", "unknown")).toBe("autonomous");
    expect(r.resolveMode("quinn", "unknown", "gated")).toBe("gated");
  });

  test("resolveMode returns declared mode when present", () => {
    const r = new HitlModeRegistry();
    r.declare({ agentName: "frank", skill: "deploy_prod", mode: "gated" });
    expect(r.resolveMode("frank", "deploy_prod")).toBe("gated");
  });

  test("compare() orders autonomous < notification < veto < gated < compound", () => {
    const r = new HitlModeRegistry();
    expect(r.compare("autonomous", "notification")).toBeLessThan(0);
    expect(r.compare("compound", "gated")).toBeGreaterThan(0);
    expect(r.compare("veto", "veto")).toBe(0);
    expect(r.compare(undefined, undefined)).toBe(0);
    expect(r.compare(undefined, "gated")).toBeLessThan(0);
  });

  test("HITL_MODE_ORDER is monotone", () => {
    const order: HitlMode[] = ["autonomous", "notification", "veto", "gated", "compound"];
    for (let i = 1; i < order.length; i++) {
      expect(HITL_MODE_ORDER[order[i]]).toBeGreaterThan(HITL_MODE_ORDER[order[i - 1]]);
    }
  });

  test("preserves vetoTtlMs when declared", () => {
    const r = new HitlModeRegistry();
    r.declare({ agentName: "a", skill: "s", mode: "veto", vetoTtlMs: 30_000 });
    expect(r.get("a", "s")?.vetoTtlMs).toBe(30_000);
  });

  test("all() + clear() behave", () => {
    const r = new HitlModeRegistry();
    r.declare({ agentName: "a", skill: "s1", mode: "gated" });
    r.declare({ agentName: "b", skill: "s2", mode: "autonomous" });
    expect(r.all()).toHaveLength(2);
    r.clear();
    expect(r.size).toBe(0);
  });
});

describe("hitl-mode-v1 extension interceptor", () => {
  let registry: HitlModeRegistry;

  beforeEach(() => {
    registry = new HitlModeRegistry();
    registerHitlModeExtension(registry);
  });

  test("registered on defaultExtensionRegistry", () => {
    const uris = defaultExtensionRegistry.list().map(e => e.uri);
    expect(uris).toContain(HITL_MODE_URI);
  });

  test("before() stamps x-hitl-mode when declared", () => {
    registry.declare({ agentName: "quinn", skill: "pr_review", mode: "gated" });
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === HITL_MODE_URI)?.interceptor;
    const ctx = makeCtx();
    interceptor!.before?.(ctx);
    expect(ctx.metadata["x-hitl-mode"]).toBe("gated");
  });

  test("before() stamps x-hitl-veto-ttl-ms when declared with veto mode", () => {
    registry.declare({ agentName: "quinn", skill: "pr_review", mode: "veto", vetoTtlMs: 15_000 });
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === HITL_MODE_URI)?.interceptor;
    const ctx = makeCtx();
    interceptor!.before?.(ctx);
    expect(ctx.metadata["x-hitl-mode"]).toBe("veto");
    expect(ctx.metadata["x-hitl-veto-ttl-ms"]).toBe(15_000);
  });

  test("before() no-op when no declaration exists", () => {
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === HITL_MODE_URI)?.interceptor;
    const ctx = makeCtx();
    interceptor!.before?.(ctx);
    expect(ctx.metadata["x-hitl-mode"]).toBeUndefined();
  });

  test("after() is not defined — mode is read-side only", () => {
    const interceptor = defaultExtensionRegistry.list().find(e => e.uri === HITL_MODE_URI)?.interceptor;
    expect(interceptor?.after).toBeUndefined();
  });
});

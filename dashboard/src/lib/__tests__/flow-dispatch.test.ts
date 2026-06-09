import { describe, test, expect } from "bun:test";
import { applyFlowDispatch } from "../flow-dispatch.ts";

const created = (agent?: string) => ({ status: "active" as const, stage: "dispatched" as const, meta: { targetAgent: agent } });

describe("applyFlowDispatch", () => {
  test("flow.item.created with a target agent adds it to the in-flight set", () => {
    const out = applyFlowDispatch(new Set(), "flow.item.created", created("roxy"));
    expect([...out]).toEqual(["roxy"]);
  });

  test("flow.item.completed removes the agent", () => {
    const live = new Set(["roxy", "quinn"]);
    const out = applyFlowDispatch(live, "flow.item.completed", { status: "complete", stage: "done", meta: { targetAgent: "roxy" } });
    expect([...out].sort()).toEqual(["quinn"]);
  });

  test("a blocked/error update is terminal — removes the agent", () => {
    const live = new Set(["quinn"]);
    const out = applyFlowDispatch(live, "flow.item.updated", { status: "blocked", stage: "error", meta: { targetAgent: "quinn" } });
    expect(out.has("quinn")).toBe(false);
  });

  test("an active update keeps the agent in-flight", () => {
    const live = new Set(["quinn"]);
    const out = applyFlowDispatch(live, "flow.item.updated", { status: "active", stage: "running", meta: { targetAgent: "quinn" } });
    expect(out.has("quinn")).toBe(true);
  });

  test("a2a and builtin dispatches are tracked identically (both flow through the hub)", () => {
    let s = new Set<string>();
    s = applyFlowDispatch(s, "flow.item.created", created("quinn")); // builtin
    s = applyFlowDispatch(s, "flow.item.created", created("roxy")); // a2a
    expect([...s].sort()).toEqual(["quinn", "roxy"]);
  });

  test("events without a target agent are inert (same reference, no churn)", () => {
    const live = new Set(["roxy"]);
    expect(applyFlowDispatch(live, "flow.item.created", created(undefined))).toBe(live);
    expect(applyFlowDispatch(live, "flow.item.created", created(""))).toBe(live);
    expect(applyFlowDispatch(live, "flow.item.created", { meta: {} })).toBe(live);
  });

  test("idempotent: re-adding a tracked agent / removing an absent one returns the same reference", () => {
    const live = new Set(["roxy"]);
    expect(applyFlowDispatch(live, "flow.item.created", created("roxy"))).toBe(live);
    expect(applyFlowDispatch(live, "flow.item.completed", { status: "complete", meta: { targetAgent: "absent" } })).toBe(live);
  });
});

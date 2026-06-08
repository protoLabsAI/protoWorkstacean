import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowStore } from "../flow-store.ts";
import type { FlowItemPayload } from "../../event-bus/payloads.ts";

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "flow-store-"));
  dirs.push(d);
  return join(d, "flow.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = 1_780_000_000_000;

function created(id: string, ts = T0): FlowItemPayload {
  return { id, type: "feature", status: "active", stage: "dispatched", createdAt: ts, startedAt: ts, meta: { skill: "pr_review", executorType: "deep-agent" } };
}

describe("FlowStore", () => {
  test("upsert merges the created → updated → completed lifecycle (COALESCE, no field nulled)", () => {
    const s = new FlowStore(tmpDb());
    s.upsert(created("skill-abc"));
    // partial update — only status/stage/meta; must NOT null createdAt/skill
    s.upsert({ id: "skill-abc", status: "active", stage: "running", meta: { taskId: "t1" } });
    // completion — sets completed_at + duration, flips status
    s.upsert({ id: "skill-abc", status: "complete", stage: "done", completedAt: T0 + 5000, meta: { skill: "pr_review" } });

    const r = s.get("skill-abc")!;
    expect(r.status).toBe("complete");
    expect(r.stage).toBe("done");
    expect(r.createdAt).toBe(T0);          // preserved from created
    expect(r.startedAt).toBe(T0);          // preserved
    expect(r.completedAt).toBe(T0 + 5000); // set on completion
    expect(r.durationMs).toBe(5000);       // computed completed - started
    expect(r.skill).toBe("pr_review");     // never nulled by the partial update
    expect(r.executorType).toBe("deep-agent");
    s.close();
  });

  test("recent returns newest-first and honors status + since filters", () => {
    const s = new FlowStore(tmpDb());
    s.upsert(created("skill-1", T0));
    s.upsert(created("skill-2", T0 + 1000));
    s.upsert({ id: "skill-3", status: "blocked", stage: "error", createdAt: T0 + 2000, startedAt: T0 + 2000, meta: { skill: "x", error: "boom" } });

    const all = s.recent();
    expect(all.map((r) => r.id)).toEqual(["skill-3", "skill-2", "skill-1"]);

    expect(s.recent({ status: "blocked" }).map((r) => r.id)).toEqual(["skill-3"]);
    expect(s.recent({ sinceMs: T0 + 1500 }).map((r) => r.id)).toEqual(["skill-3"]);
    expect(s.recent({ limit: 1 }).map((r) => r.id)).toEqual(["skill-3"]);
    s.close();
  });

  test("error preview is captured + truncated", () => {
    const s = new FlowStore(tmpDb());
    s.upsert({ id: "skill-e", status: "blocked", createdAt: T0, meta: { error: "x".repeat(900) } });
    const r = s.get("skill-e")!;
    expect(r.errorPreview).toHaveLength(500);
    s.close();
  });

  test("prune removes items older than the cutoff", () => {
    const s = new FlowStore(tmpDb());
    s.upsert(created("old", T0));
    s.upsert(created("new", T0 + 10_000));
    const removed = s.prune(T0 + 5000);
    expect(removed).toBe(1);
    expect(s.recent().map((r) => r.id)).toEqual(["new"]);
    s.close();
  });

  test("durable across reopen", () => {
    const path = tmpDb();
    const s1 = new FlowStore(path);
    s1.upsert(created("skill-keep"));
    s1.close();
    const s2 = new FlowStore(path);
    expect(s2.get("skill-keep")?.skill).toBe("pr_review");
    s2.close();
  });

  test("get of an absent id → null; empty store degrades cleanly", () => {
    const s = new FlowStore(tmpDb());
    expect(s.get("nope")).toBeNull();
    expect(s.recent()).toEqual([]);
    expect(s.count()).toBe(0);
    s.close();
  });
});

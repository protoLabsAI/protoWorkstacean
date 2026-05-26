/**
 * Verifies that pr-remediator's stuck-PR escalation publishes
 * `operator.message.request` (consumed by OperatorRoutingPlugin in production)
 * — the Phase 1 reconnect of the HITL flow ripped in f658744.
 *
 * The plugin's full state machine is covered by integration paths; this test
 * exercises _emitStuckHitlEscalation directly to verify the bus contract.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../bus.ts";
import { PrRemediatorPlugin } from "../pr-remediator.ts";
import type { BusMessage } from "../../types.ts";

type FakeEntry = {
  kind: string;
  startedAt: number;
  correlationId: string;
  attempts: number;
  exhausted: boolean;
  escalated?: boolean;
};

function withPrInPipeline(plugin: PrRemediatorPlugin, repo: string, number: number, extra: Record<string, unknown> = {}): void {
  // Inject a minimal pr_pipeline snapshot so the "no longer in pipeline"
  // suppression path doesn't fire.
  (plugin as unknown as { latestPrData: { prs: unknown[] } }).latestPrData = {
    prs: [{ repo, number, headSha: "deadbeef", ciStatus: "fail", ...extra }],
  };
}

describe("pr-remediator stuck-PR HITL escalation → operator.message.request", () => {
  let bus: InMemoryEventBus;
  let plugin: PrRemediatorPlugin;
  let captured: BusMessage[];

  beforeEach(() => {
    bus = new InMemoryEventBus();
    captured = [];
    bus.subscribe("operator.message.request", "test-collector", msg => {
      captured.push(msg);
    });
    // Stub the live-CI fetcher so escalation doesn't get suppressed by a
    // "CI is actually green now" check.
    plugin = new PrRemediatorPlugin({
      fetchLiveCiStatus: async () => "fail",
    });
    plugin.install(bus);
  });

  afterEach(() => {
    plugin.uninstall();
  });

  test("budget-exhaustion escalation publishes operator.message.request with urgency=normal", async () => {
    withPrInPipeline(plugin, "protoLabsAI/foo", 123);
    const entry: FakeEntry = {
      kind: "fix_ci",
      startedAt: Date.now() - 5 * 60_000,
      correlationId: "corr-1",
      attempts: 3,
      exhausted: true,
      escalated: true,
    };

    await (plugin as unknown as {
      _emitStuckHitlEscalation: (repo: string, number: number, kind: string, entry: FakeEntry) => Promise<void>;
    })._emitStuckHitlEscalation("protoLabsAI/foo", 123, "fix_ci", entry);

    expect(captured).toHaveLength(1);
    const payload = captured[0]!.payload as {
      type: string;
      correlationId: string;
      message: string;
      urgency: string;
      topic: string;
      from: string;
    };
    expect(payload.type).toBe("operator_message_request");
    expect(payload.correlationId).toBe("corr-1");
    expect(payload.urgency).toBe("normal");
    expect(payload.from).toBe("pr-remediator");
    expect(payload.topic).toBe("pr-remediation-stuck/protoLabsAI/foo#123/fix_ci");
    expect(payload.message).toContain("3/3");
    expect(payload.message).toContain("fix_ci");
    expect(payload.message).toContain("https://github.com/protoLabsAI/foo/pull/123");
  });

  test("conflict-bearing escalation bumps urgency to high and includes the conflict detail", async () => {
    withPrInPipeline(plugin, "protoLabsAI/foo", 456, {
      headRef: "feat/x",
      baseRef: "main",
    });
    const entry: FakeEntry = {
      kind: "update_branch",
      startedAt: Date.now() - 12 * 60_000,
      correlationId: "corr-2",
      attempts: 3,
      exhausted: true,
      escalated: true,
    };

    await (plugin as unknown as {
      _emitStuckHitlEscalation: (
        repo: string,
        number: number,
        kind: string,
        entry: FakeEntry,
        conflictDetails?: string,
      ) => Promise<void>;
    })._emitStuckHitlEscalation(
      "protoLabsAI/foo",
      456,
      "update_branch",
      entry,
      "Promotion-PR guard tripped: head=feat/x base=main",
    );

    expect(captured).toHaveLength(1);
    const payload = captured[0]!.payload as { urgency: string; message: string };
    expect(payload.urgency).toBe("high");
    expect(payload.message).toContain("Promotion-PR guard tripped");
  });

  test("no escalation when the PR has left the pipeline (closed/merged)", async () => {
    // latestPrData not set → PR not in pipeline → suppressed
    const entry: FakeEntry = {
      kind: "fix_ci",
      startedAt: Date.now(),
      correlationId: "corr-3",
      attempts: 3,
      exhausted: true,
    };

    await (plugin as unknown as {
      _emitStuckHitlEscalation: (repo: string, number: number, kind: string, entry: FakeEntry) => Promise<void>;
    })._emitStuckHitlEscalation("protoLabsAI/foo", 789, "fix_ci", entry);

    expect(captured).toHaveLength(0);
  });

  test("no escalation when live CI says the PR is actually green (suppression race)", async () => {
    plugin.uninstall();
    plugin = new PrRemediatorPlugin({
      fetchLiveCiStatus: async () => "pass",
    });
    plugin.install(bus);
    withPrInPipeline(plugin, "protoLabsAI/foo", 999);

    const entry: FakeEntry = {
      kind: "fix_ci",
      startedAt: Date.now(),
      correlationId: "corr-4",
      attempts: 3,
      exhausted: true,
    };

    await (plugin as unknown as {
      _emitStuckHitlEscalation: (repo: string, number: number, kind: string, entry: FakeEntry) => Promise<void>;
    })._emitStuckHitlEscalation("protoLabsAI/foo", 999, "fix_ci", entry);

    expect(captured).toHaveLength(0);
  });
});

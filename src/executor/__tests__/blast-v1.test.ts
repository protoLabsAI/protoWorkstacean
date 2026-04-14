/**
 * Tests for the blast-v1 extension.
 *
 * Covers:
 *   - blastRadiusOrdinal ordering
 *   - requiresHITL threshold
 *   - declareBlastRadius / getBlastRadius / clearBlastRadii
 *   - before() hook: metadata stamping
 *   - after() hook: skill.blast.executed event publication
 *   - No metadata stamped when blast radius undeclared
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  BLAST_V1_URI,
  type BlastRadius,
  blastRadiusOrdinal,
  requiresHITL,
  declareBlastRadius,
  getBlastRadius,
  clearBlastRadii,
  _clearAllBlastRadii,
  registerBlastV1Extension,
  type BlastExecutedPayload,
} from "../extensions/blast-v1.ts";
import { defaultExtensionRegistry } from "../extension-registry.ts";
import type { EventBus, BusMessage } from "../../../lib/types.ts";

// ── Minimal stub bus ──────────────────────────────────────────────────────────

interface CapturedEvent {
  topic: string;
  message: BusMessage;
}

function makeStubBus(): { bus: EventBus; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  const bus = {
    publish(topic: string, message: BusMessage) {
      events.push({ topic, message });
    },
    subscribe: () => "stub-sub-id",
    unsubscribe: () => {},
    topics: () => [],
  } as unknown as EventBus;
  return { bus, events };
}

// ── Minimal ExtensionContext builder ─────────────────────────────────────────

function makeCtx(
  agentName: string,
  skill: string,
  metadata: Record<string, unknown> = {},
) {
  return { agentName, skill, correlationId: "corr-123", metadata };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _clearAllBlastRadii();
});

// ── Utility unit tests ────────────────────────────────────────────────────────

describe("blastRadiusOrdinal", () => {
  test("orders radii from least to most impactful", () => {
    const order: BlastRadius[] = ["self", "project", "repo", "fleet", "public"];
    for (let i = 0; i < order.length - 1; i++) {
      expect(blastRadiusOrdinal(order[i])).toBeLessThan(
        blastRadiusOrdinal(order[i + 1]),
      );
    }
  });
});

describe("requiresHITL", () => {
  test.each([
    ["self", false],
    ["project", false],
    ["repo", false],
    ["fleet", true],
    ["public", true],
  ] as [BlastRadius, boolean][])(
    "%s → requiresHITL=%s",
    (radius, expected) => {
      expect(requiresHITL(radius)).toBe(expected);
    },
  );
});

describe("declareBlastRadius / getBlastRadius", () => {
  test("returns declared radius for agent+skill", () => {
    declareBlastRadius("quinn", "create_pr", "repo");
    expect(getBlastRadius("quinn", "create_pr")).toBe("repo");
  });

  test("returns undefined for undeclared agent+skill", () => {
    expect(getBlastRadius("quinn", "unknown_skill")).toBeUndefined();
  });

  test("overwrite with new declaration replaces old value", () => {
    declareBlastRadius("quinn", "deploy", "repo");
    declareBlastRadius("quinn", "deploy", "fleet");
    expect(getBlastRadius("quinn", "deploy")).toBe("fleet");
  });

  test("different agents do not collide on same skill name", () => {
    declareBlastRadius("quinn", "deploy", "repo");
    declareBlastRadius("ava", "deploy", "fleet");
    expect(getBlastRadius("quinn", "deploy")).toBe("repo");
    expect(getBlastRadius("ava", "deploy")).toBe("fleet");
  });
});

describe("clearBlastRadii", () => {
  test("removes all skills for a given agent", () => {
    declareBlastRadius("quinn", "create_pr", "repo");
    declareBlastRadius("quinn", "deploy", "fleet");
    declareBlastRadius("ava", "summarize", "self");
    clearBlastRadii("quinn");
    expect(getBlastRadius("quinn", "create_pr")).toBeUndefined();
    expect(getBlastRadius("quinn", "deploy")).toBeUndefined();
    // other agents unaffected
    expect(getBlastRadius("ava", "summarize")).toBe("self");
  });
});

// ── Interceptor tests ─────────────────────────────────────────────────────────
// We register the extension once here and grab the interceptor from the
// defaultExtensionRegistry so we can call before/after directly without
// going through the full bus dispatch stack.

describe("blast-v1 interceptor — before()", () => {
  const { bus } = makeStubBus();
  registerBlastV1Extension(bus);
  const interceptor = defaultExtensionRegistry
    .list()
    .find((d) => d.uri === BLAST_V1_URI)!.interceptor!;

  test("stamps radius and requiresHITL=false for low-blast skill", () => {
    declareBlastRadius("quinn", "create_pr", "repo");
    const metadata: Record<string, unknown> = {};
    interceptor.before!(makeCtx("quinn", "create_pr", metadata));
    expect(metadata["x-blast-v1-radius"]).toBe("repo");
    expect(metadata["x-blast-v1-requires-hitl"]).toBe(false);
  });

  test("stamps requiresHITL=true for fleet blast radius", () => {
    declareBlastRadius("quinn", "fleet_restart", "fleet");
    const metadata: Record<string, unknown> = {};
    interceptor.before!(makeCtx("quinn", "fleet_restart", metadata));
    expect(metadata["x-blast-v1-radius"]).toBe("fleet");
    expect(metadata["x-blast-v1-requires-hitl"]).toBe(true);
  });

  test("stamps requiresHITL=true for public blast radius", () => {
    declareBlastRadius("quinn", "publish_release", "public");
    const metadata: Record<string, unknown> = {};
    interceptor.before!(makeCtx("quinn", "publish_release", metadata));
    expect(metadata["x-blast-v1-radius"]).toBe("public");
    expect(metadata["x-blast-v1-requires-hitl"]).toBe(true);
  });

  test("stamps nothing when blast radius undeclared for skill", () => {
    const metadata: Record<string, unknown> = {};
    interceptor.before!(makeCtx("quinn", "no_blast_declared", metadata));
    expect(metadata["x-blast-v1-radius"]).toBeUndefined();
    expect(metadata["x-blast-v1-requires-hitl"]).toBeUndefined();
  });
});

describe("blast-v1 interceptor — after()", () => {
  const { bus: afterBus, events } = makeStubBus();
  registerBlastV1Extension(afterBus);
  const interceptor = defaultExtensionRegistry
    .list()
    .find((d) => d.uri === BLAST_V1_URI)!.interceptor!;

  beforeEach(() => {
    events.length = 0;
  });

  test("publishes skill.blast.executed with correct payload", () => {
    declareBlastRadius("quinn", "create_pr", "repo");
    interceptor.after!(makeCtx("quinn", "create_pr"), { text: "done" });

    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.topic).toBe("skill.blast.executed");

    const payload = evt.message.payload as BlastExecutedPayload;
    expect(payload.source).toBe("quinn");
    expect(payload.skill).toBe("create_pr");
    expect(payload.radius).toBe("repo");
    expect(payload.requiresHITL).toBe(false);
  });

  test("publishes requiresHITL=true for fleet skill", () => {
    declareBlastRadius("quinn", "fleet_restart", "fleet");
    interceptor.after!(makeCtx("quinn", "fleet_restart"), { text: "" });

    const payload = events[0].message.payload as BlastExecutedPayload;
    expect(payload.requiresHITL).toBe(true);
  });

  test("does not publish when blast radius undeclared", () => {
    interceptor.after!(makeCtx("quinn", "undeclared_skill"), { text: "" });
    expect(events).toHaveLength(0);
  });

  test("falls back to metadata radius when registry has no entry", () => {
    // Simulate: before() stamped radius on metadata, then registry was cleared
    const ctx = makeCtx("quinn", "some_skill", {
      "x-blast-v1-radius": "project" as BlastRadius,
    });
    interceptor.after!(ctx, { text: "" });

    expect(events).toHaveLength(1);
    const payload = events[0].message.payload as BlastExecutedPayload;
    expect(payload.radius).toBe("project");
    expect(payload.requiresHITL).toBe(false);
  });
});

describe("BLAST_V1_URI", () => {
  test("has the expected URI", () => {
    expect(BLAST_V1_URI).toBe("https://protolabs.ai/a2a/ext/blast-v1");
  });

  test("is registered in defaultExtensionRegistry", () => {
    const { bus } = makeStubBus();
    registerBlastV1Extension(bus);
    const uris = defaultExtensionRegistry.list().map((d) => d.uri);
    expect(uris).toContain(BLAST_V1_URI);
  });
});

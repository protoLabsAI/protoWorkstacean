/**
 * Tests for the blast-radius v1 extension.
 *
 * Covers:
 *   - before() stamps x-blast-radius-skill in metadata
 *   - after() publishes skill.blast.observed when result contains blast data
 *   - after() is a no-op when result has no blast data
 *   - registerBlastExtension registers to the defaultExtensionRegistry
 */

import { describe, test, expect, mock } from "bun:test";
import {
  BLAST_URI,
  registerBlastExtension,
  type SkillBlastPayload,
} from "../extensions/blast.ts";
import { ExtensionRegistry, defaultExtensionRegistry } from "../extension-registry.ts";
import type { EventBus } from "../../../lib/types.ts";

function makeCtx(overrides?: Partial<{ agentName: string; skill: string; correlationId: string }>) {
  return {
    agentName: overrides?.agentName ?? "test-agent",
    skill: overrides?.skill ?? "my_skill",
    correlationId: overrides?.correlationId ?? "corr-123",
    metadata: {} as Record<string, unknown>,
  };
}

function makeBus() {
  const published: Array<{ topic: string; message: unknown }> = [];
  const bus = {
    publish(topic: string, message: unknown) {
      published.push({ topic, message });
    },
  } as unknown as EventBus;
  return { bus, published };
}

describe("blast-radius v1 extension — interceptor", () => {
  test("before() stamps x-blast-radius-skill in metadata", () => {
    const { bus } = makeBus();
    // Use an isolated registry to avoid polluting defaultExtensionRegistry
    const reg = new ExtensionRegistry();
    const interceptors: ReturnType<typeof reg.interceptorsFor> = [];

    // Manually invoke the register function on the default registry but capture
    // the interceptor by spying on reg.register
    let capturedInterceptor: (typeof interceptors)[number] | undefined;
    const origRegister = reg.register.bind(reg);
    reg.register = (def) => {
      origRegister(def);
      capturedInterceptor = def.interceptor;
    };

    // We need to call registerBlastExtension but it uses defaultExtensionRegistry.
    // Instead, directly test the interceptor shape by calling registerBlastExtension
    // and reading from the default registry.
    registerBlastExtension(bus);

    const defs = defaultExtensionRegistry.list();
    const blastDef = defs.find((d) => d.uri === BLAST_URI);
    expect(blastDef).toBeDefined();

    const interceptor = blastDef!.interceptor!;
    const ctx = makeCtx({ skill: "send_slack_message" });
    interceptor.before!(ctx);
    expect(ctx.metadata["x-blast-radius-skill"]).toBe("send_slack_message");
  });

  test("after() publishes skill.blast.observed when result contains blast data", async () => {
    const { bus, published } = makeBus();

    // Re-use the already-registered interceptor from the default registry
    const blastDef = defaultExtensionRegistry.list().find((d) => d.uri === BLAST_URI);
    expect(blastDef).toBeDefined();
    const interceptor = blastDef!.interceptor!;

    const ctx = makeCtx({ agentName: "slack-agent", skill: "send_slack_message", correlationId: "c-999" });
    const result = {
      text: "done",
      data: {
        "x-blast-radius": {
          radius: "public" as const,
          description: "Posts to a public Slack channel",
        },
      },
    };

    await interceptor.after!(ctx, result);

    expect(published).toHaveLength(1);
    const msg = published[0];
    expect(msg.topic).toBe("skill.blast.observed");

    const envelope = msg.message as {
      topic: string;
      correlationId: string;
      payload: SkillBlastPayload;
    };
    expect(envelope.correlationId).toBe("c-999");
    expect(envelope.payload.source).toBe("slack-agent");
    expect(envelope.payload.skill).toBe("send_slack_message");
    expect(envelope.payload.blast.radius).toBe("public");
    expect(envelope.payload.blast.description).toBe("Posts to a public Slack channel");
  });

  test("after() is a no-op when result has no blast data", async () => {
    const { bus, published } = makeBus();

    const blastDef = defaultExtensionRegistry.list().find((d) => d.uri === BLAST_URI);
    const interceptor = blastDef!.interceptor!;

    const ctx = makeCtx();
    await interceptor.after!(ctx, { text: "done", data: {} });
    expect(published).toHaveLength(0);
  });

  test("after() is a no-op when result.data is undefined", async () => {
    const { bus, published } = makeBus();

    const blastDef = defaultExtensionRegistry.list().find((d) => d.uri === BLAST_URI);
    const interceptor = blastDef!.interceptor!;

    const ctx = makeCtx();
    await interceptor.after!(ctx, { text: "done" });
    expect(published).toHaveLength(0);
  });

  test("registerBlastExtension registers with URI blast-v1", () => {
    const blastDef = defaultExtensionRegistry.list().find((d) => d.uri === BLAST_URI);
    expect(blastDef).toBeDefined();
    expect(blastDef!.uri).toBe("https://protolabs.ai/a2a/ext/blast-v1");
  });
});

describe("blast-radius v1 — radius levels", () => {
  test("all radius levels are accepted in payload", async () => {
    const { bus, published } = makeBus();

    const blastDef = defaultExtensionRegistry.list().find((d) => d.uri === BLAST_URI);
    const interceptor = blastDef!.interceptor!;

    for (const radius of ["self", "project", "repo", "fleet", "public"] as const) {
      const ctx = makeCtx({ skill: "some_skill" });
      await interceptor.after!(ctx, {
        text: "done",
        data: { "x-blast-radius": { radius } },
      });
    }

    expect(published).toHaveLength(5);
    const radii = published.map((p) => {
      const env = p.message as { payload: SkillBlastPayload };
      return env.payload.blast.radius;
    });
    expect(radii).toEqual(["self", "project", "repo", "fleet", "public"]);
  });
});

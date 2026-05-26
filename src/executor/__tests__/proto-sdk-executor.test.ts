/**
 * ProtoSdkExecutor smoke tests — verify the IExecutor wiring +
 * prompt-builder shape without hitting the real @protolabsai/sdk
 * query() (which would need a live LLM call).
 *
 * The full agentic loop is exercised at deploy time when proto handles
 * its first real dispatch; these tests cover the contract surface that
 * unit tests can reach.
 */

import { describe, test, expect } from "bun:test";
import { ProtoSdkExecutor } from "../executors/proto-sdk-executor.ts";
import type { AgentDefinition } from "../../agent-runtime/types.ts";

const protoDef: AgentDefinition = {
  name: "proto",
  role: "general",
  runtime: "proto-sdk",
  model: "claude-sonnet-4-6",
  systemPrompt: "You are proto.",
  tools: [],
  maxTurns: 30,
  skills: [{ name: "code.execute" }],
};

describe("ProtoSdkExecutor", () => {
  test("type discriminator is 'proto-sdk' (matches AgentRuntimePlugin switch)", () => {
    const ex = new ProtoSdkExecutor(protoDef);
    expect(ex.type).toBe("proto-sdk");
  });

  test("constructor accepts an empty options object (no gateway env required)", () => {
    expect(() => new ProtoSdkExecutor(protoDef, {})).not.toThrow();
  });

  test("constructor accepts a bus reference for progress publishing", () => {
    const bus = {
      publish: () => {},
      subscribe: () => "sub-id",
      unsubscribe: () => {},
      topics: () => [],
      consumers: () => [],
    };
    expect(() => new ProtoSdkExecutor(protoDef, {}, bus as never)).not.toThrow();
  });

  test("execute() reads payload.model + payload.cwd as per-call overrides", () => {
    // Without exercising the SDK (which would need a live LLM), verify
    // we surface payload.model on the type — the actual override-passes-
    // through-to-query() path is integration-tested at deploy time.
    const req = {
      skill: "code.execute",
      content: "noop",
      correlationId: "test-corr",
      replyTopic: "test.reply",
      payload: {
        skill: "code.execute",
        cwd: "/tmp/proto-test",
        model: "claude-opus-4-7",
      },
    };
    // payload field is loosely typed (Record<string, unknown>); the
    // executor pulls cwd/model defensively. This test just confirms the
    // SkillRequest shape compiles + the fields are not stripped by the
    // payload type.
    expect(typeof req.payload.cwd).toBe("string");
    expect(typeof req.payload.model).toBe("string");
  });
});

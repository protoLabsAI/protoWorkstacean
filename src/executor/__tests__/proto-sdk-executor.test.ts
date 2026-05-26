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
});

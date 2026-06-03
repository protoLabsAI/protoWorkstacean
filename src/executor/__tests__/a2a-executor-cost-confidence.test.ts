import { describe, test, expect } from "bun:test";
import { TaskState } from "@a2a-js/sdk";
import { A2AExecutor } from "../executors/a2a-executor.ts";
import { COST_V1_MIME_TYPE, CONFIDENCE_V1_MIME_TYPE } from "@protolabs/a2a";

// Access the private extractors via `as any` — we're asserting pure-function
// behavior on part arrays, not the full execute() plumbing.
type PartsScan = {
  _costFromParts(parts: unknown[]): unknown;
  _confidenceFromParts(parts: unknown[]): unknown;
  _flattenExtensionData(cost: unknown, confidence: unknown, taskState: string): Record<string, unknown>;
};

function makeExec(): PartsScan {
  const exec = new A2AExecutor({
    name: "quinn",
    url: "http://quinn:7870/a2a",
    streaming: false,
    pushNotifications: false,
  });
  return exec as unknown as PartsScan;
}

describe("A2AExecutor cost-v1 / confidence-v1 extraction", () => {
  test("_costFromParts returns the cost payload on match", () => {
    const exec = makeExec();
    const parts = [
      { content: { $case: "text", value: "ignored" } },
      {
        content: {
          $case: "data",
          value: {
            usage: { input_tokens: 1500, output_tokens: 420, cache_read_input_tokens: 120 },
            durationMs: 4200,
            costUsd: 0.0123,
          },
        },
        metadata: { mimeType: COST_V1_MIME_TYPE },
      },
    ];
    const cost = exec._costFromParts(parts) as { usage: { input_tokens: number }; durationMs: number; costUsd: number };
    expect(cost).toBeDefined();
    expect(cost.usage.input_tokens).toBe(1500);
    expect(cost.durationMs).toBe(4200);
    expect(cost.costUsd).toBe(0.0123);
  });

  test("_costFromParts returns undefined when no matching part", () => {
    const exec = makeExec();
    expect(exec._costFromParts([{ content: { $case: "text", value: "hi" } }])).toBeUndefined();
    expect(exec._costFromParts([
      { content: { $case: "data", value: { foo: "bar" } }, metadata: { mimeType: "application/other+json" } },
    ])).toBeUndefined();
  });

  test("_confidenceFromParts returns payload with explanation", () => {
    const exec = makeExec();
    const parts = [
      {
        content: { $case: "data", value: { confidence: 0.88, explanation: "spec unambiguous; all tests pass" } },
        metadata: { mimeType: CONFIDENCE_V1_MIME_TYPE },
      },
    ];
    const c = exec._confidenceFromParts(parts) as { confidence: number; explanation: string };
    expect(c.confidence).toBe(0.88);
    expect(c.explanation).toBe("spec unambiguous; all tests pass");
  });

  test("_flattenExtensionData merges cost + confidence onto result.data shape", () => {
    const exec = makeExec();
    const flattened = exec._flattenExtensionData(
      { usage: { input_tokens: 100, output_tokens: 50 }, durationMs: 1000, costUsd: 0.001 },
      { confidence: 0.75, explanation: "reasonable confidence" },
      "completed",
    );
    expect(flattened.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(flattened.durationMs).toBe(1000);
    expect(flattened.costUsd).toBe(0.001);
    expect(flattened.success).toBe(true);
    expect(flattened.confidence).toBe(0.75);
    expect(flattened.confidenceExplanation).toBe("reasonable confidence");
  });

  test("_flattenExtensionData derives success=false from non-completed taskState when cost omits it", () => {
    const exec = makeExec();
    const flattened = exec._flattenExtensionData(
      { usage: { input_tokens: 10, output_tokens: 5 } },
      undefined,
      "failed",
    );
    expect(flattened.success).toBe(false);
    expect(flattened.confidence).toBeUndefined();
  });

  test("_flattenExtensionData respects explicit success flag even when taskState disagrees", () => {
    const exec = makeExec();
    const flattened = exec._flattenExtensionData(
      { usage: { input_tokens: 10, output_tokens: 5 }, success: false },
      undefined,
      "completed",
    );
    expect(flattened.success).toBe(false);
  });

  test("_flattenExtensionData returns {} when neither payload present", () => {
    const exec = makeExec();
    expect(exec._flattenExtensionData(undefined, undefined, "completed")).toEqual({});
  });
});

// Regression for #763: the tasks/get poll path (taken whenever a streaming
// agent emits a non-terminal task event first — i.e. virtually every real task)
// used to surface only text + state, silently dropping cost-v1/confidence-v1.
describe("A2AExecutor.pollTask surfaces extension DataParts (#763)", () => {
  function execWithTask(task: unknown): A2AExecutor {
    const exec = new A2AExecutor({
      name: "roxy",
      url: "http://roxy:7870/a2a",
      streaming: true,
      pushNotifications: false,
    });
    // Stub the client build so no network/card fetch happens.
    (exec as unknown as { _buildClient: () => Promise<unknown> })._buildClient =
      async () => ({ getTask: async () => task });
    return exec;
  }

  const terminalTask = {
    id: "t-763",
    contextId: "ctx-763",
    status: { state: TaskState.TASK_STATE_COMPLETED },
    artifacts: [
      {
        artifactId: "a1",
        parts: [
          { content: { $case: "text", value: "portfolio sitrep…" } },
          {
            content: {
              $case: "data",
              value: { usage: { input_tokens: 54339, output_tokens: 1969 }, costUsd: 0.006221, success: true },
            },
            metadata: { mimeType: COST_V1_MIME_TYPE },
          },
          {
            content: { $case: "data", value: { confidence: 0.92, explanation: "consistent across sources", success: true } },
            metadata: { mimeType: CONFIDENCE_V1_MIME_TYPE },
          },
        ],
      },
    ],
  };

  test("poll result.data carries costUsd + usage + confidence (not just text)", async () => {
    const exec = execWithTask(terminalTask);
    const res = await exec.pollTask("t-763", "corr-763");
    expect(res.text).toBe("portfolio sitrep…");
    expect(res.data?.costUsd).toBe(0.006221);
    expect(res.data?.usage).toEqual({ input_tokens: 54339, output_tokens: 1969 });
    expect(res.data?.confidence).toBe(0.92);
    expect(res.data?.confidenceExplanation).toBe("consistent across sources");
  });

  test("poll result omits cost/confidence cleanly when the task emits no such parts", async () => {
    const exec = execWithTask({
      id: "t2",
      contextId: "ctx2",
      status: { state: TaskState.TASK_STATE_COMPLETED },
      artifacts: [{ artifactId: "a1", parts: [{ content: { $case: "text", value: "pong" } }] }],
    });
    const res = await exec.pollTask("t2", "corr2");
    expect(res.text).toBe("pong");
    expect(res.data?.costUsd).toBeUndefined();
    expect(res.data?.confidence).toBeUndefined();
  });
});

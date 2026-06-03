import { describe, test, expect } from "bun:test";
import { Part } from "@a2a-js/sdk";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import type { BusMessage } from "../../../lib/types.ts";
import { TaskTracker } from "../task-tracker.ts";
import { emitWorldStateDelta, textPart } from "@protolabs/a2a";
import type { A2AExecutor } from "../executors/a2a-executor.ts";

// Regression for #765: TaskTracker's webhook-callback path used to read the
// legacy 0.3 part shape ({kind,text,data}). A 1.0 push body is RAW proto3-JSON
// (text part = {text}, data part = {data,metadata,mediaType} — no `kind`), so
// text came back empty and worldstate-delta never published. The fix normalizes
// via Part.fromJSON and uses the @protolabs/a2a helpers.

/** Serialize a part to the proto3-JSON wire shape an agent's push body carries. */
const wire = (p: Part) => Part.toJSON(p) as unknown;

function makeTracker() {
  const bus = new InMemoryEventBus();
  const tracker = new TaskTracker({ bus });
  tracker.track({
    correlationId: "corr-765",
    taskId: "task-765",
    agentName: "roxy",
    replyTopic: "agent.skill.response.corr-765",
    executor: {} as unknown as A2AExecutor,
  });
  return { bus, tracker };
}

describe("TaskTracker handleCallback — 1.0 raw-wire parts (#765)", () => {
  test("extracts answer text + publishes worldstate-delta from a raw-wire callback body", () => {
    const { bus, tracker } = makeTracker();
    const replies: BusMessage[] = [];
    const deltas: BusMessage[] = [];
    bus.subscribe("agent.skill.response.corr-765", "t", (m) => { replies.push(m); });
    bus.subscribe("world.state.delta", "t", (m) => { deltas.push(m); });

    tracker.handleCallback("corr-765", {
      status: { state: "completed" },
      artifacts: [
        { parts: [
          wire(textPart("Portfolio is healthy — 0 blocked PRs.")),
          wire(emitWorldStateDelta({ deltas: [{ domain: "ci", path: "data.blockedPRs", op: "set", value: 0 }] })),
        ] },
      ],
    });

    // text extracted from the raw-wire text part (was empty under the 0.3 filter)
    expect(replies).toHaveLength(1);
    const reply = replies[0].payload as Record<string, unknown>;
    expect(reply.content).toBe("Portfolio is healthy — 0 blocked PRs.");
    expect(reply.taskState).toBe("completed");

    // worldstate-delta published from the raw-wire data part (was dropped)
    expect(deltas).toHaveLength(1);
    expect(deltas[0].payload as Record<string, unknown>).toMatchObject({
      domain: "ci", path: "data.blockedPRs", op: "set", value: 0,
      sourceAgent: "roxy", sourceTaskId: "task-765",
    });
    tracker.destroy();
  });

  test("input-required text reads from raw-wire status.message parts", () => {
    const { bus, tracker } = makeTracker();
    const replies: BusMessage[] = [];
    bus.subscribe("agent.skill.response.corr-765", "t", (m) => { replies.push(m); });

    tracker.handleCallback("corr-765", {
      status: { state: "input-required", message: { parts: [wire(textPart("Approve shell command?"))] } },
    });

    expect(replies).toHaveLength(1);
    expect((replies[0].payload as Record<string, unknown>).error).toContain("Approve shell command?");
    tracker.destroy();
  });
});

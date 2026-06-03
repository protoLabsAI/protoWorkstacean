import { describe, expect, test } from "bun:test";
import { extractToolCallNarrations } from "../executors/deep-agent-executor.ts";

/** Minimal stand-ins for LangChain message objects. */
const ai = (toolCalls?: Array<{ name: string; args?: unknown }>) => ({
  _getType: () => "ai",
  tool_calls: toolCalls,
});
const human = (text = "hi") => ({ _getType: () => "human", content: text });
const tool = (content = "result") => ({ _getType: () => "tool", content });

describe("extractToolCallNarrations", () => {
  test("returns one narration per AI message carrying tool_calls", () => {
    const msgs = [human(), ai([{ name: "get_incidents" }, { name: "get_ci_health" }])];
    const out = extractToolCallNarrations(msgs, 0);
    expect(out).toHaveLength(1);
    expect(out[0].toolNames).toEqual(["get_incidents", "get_ci_health"]);
    expect(out[0].toolCalls).toEqual([{ name: "get_incidents", args: undefined }, { name: "get_ci_health", args: undefined }]);
  });

  test("ignores human messages, tool results, and AI messages with no tool_calls", () => {
    const msgs = [human(), tool(), ai(), ai([])];
    expect(extractToolCallNarrations(msgs, 0)).toHaveLength(0);
  });

  test("the cursor narrates each turn exactly once across re-yielded accumulated state", () => {
    // streamMode "values" re-yields the full, growing messages array each step.
    const step1 = [human(), ai([{ name: "search" }])];
    const step2 = [...step1, tool(), ai([{ name: "fetch" }])];
    const step3 = [...step2, tool(), ai()]; // final answer, no tool calls

    let cursor = 0;
    const narrated: string[] = [];
    for (const state of [step1, step2, step3]) {
      for (const n of extractToolCallNarrations(state, cursor)) narrated.push(...n.toolNames);
      cursor = state.length;
    }
    // Each tool-call turn narrated once, in order — no double-fire on re-yield.
    expect(narrated).toEqual(["search", "fetch"]);
  });

  test("narrates several tool-call turns that land in a single step", () => {
    const msgs = [human(), ai([{ name: "a" }]), tool(), ai([{ name: "b" }, { name: "c" }])];
    const out = extractToolCallNarrations(msgs, 0);
    expect(out).toHaveLength(2);
    expect(out.flatMap((n) => n.toolNames)).toEqual(["a", "b", "c"]);
  });

  test("preserves tool args for downstream humanization", () => {
    const msgs = [ai([{ name: "chat_with_agent", args: { agent: "quinn" } }])];
    const out = extractToolCallNarrations(msgs, 0);
    expect(out[0].toolCalls[0].args).toEqual({ agent: "quinn" });
  });

  test("supports AIMessage constructor-name fallback when _getType is absent", () => {
    const msg = Object.assign(Object.create({ constructor: { name: "AIMessage" } }), { tool_calls: [{ name: "x" }] });
    // constructor.name fallback path
    const out = extractToolCallNarrations([{ constructor: { name: "AIMessage" }, tool_calls: [{ name: "x" }] }], 0);
    expect(out).toHaveLength(1);
    expect(out[0].toolNames).toEqual(["x"]);
    void msg;
  });

  test("drops nameless tool calls", () => {
    const out = extractToolCallNarrations([ai([{ name: "" }, { name: "real" }])], 0);
    expect(out).toHaveLength(1);
    expect(out[0].toolNames).toEqual(["real"]);
  });
});

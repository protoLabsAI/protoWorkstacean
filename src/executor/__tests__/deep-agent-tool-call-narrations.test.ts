import { describe, expect, test } from "bun:test";
import { extractToolCallNarrations, extractToolFrames } from "../executors/deep-agent-executor.ts";

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

/** AI message with id'd tool calls + a tool-result message. */
const aiIds = (toolCalls: Array<{ name: string; args?: unknown; id?: string }>) => ({ _getType: () => "ai", tool_calls: toolCalls });
const toolResult = (opts: { tool_call_id?: string; name?: string; content?: unknown; status?: string }) => ({ _getType: () => "tool", ...opts });

describe("extractToolFrames (tool-call-v1)", () => {
  test("emits a 'started' frame per tool call, keyed by call id", () => {
    const frames = extractToolFrames([aiIds([{ name: "get_ci_health", args: { repo: "x" }, id: "call_1" }])], 0);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ toolCallId: "call_1", name: "get_ci_health", phase: "started", args: { repo: "x" } });
  });

  test("emits a 'completed' frame from a tool-result message, correlated by tool_call_id", () => {
    const msgs = [aiIds([{ name: "get_ci_health", id: "call_1" }]), toolResult({ tool_call_id: "call_1", name: "get_ci_health", content: "all green" })];
    const frames = extractToolFrames(msgs, 0);
    expect(frames).toHaveLength(2);
    expect(frames[0].phase).toBe("started");
    expect(frames[1]).toEqual({ toolCallId: "call_1", name: "get_ci_health", phase: "completed", result: "all green" });
  });

  test("emits a 'failed' frame when the tool result is an error", () => {
    const frames = extractToolFrames([toolResult({ tool_call_id: "c", name: "boom", content: "kaboom", status: "error" })], 0);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ toolCallId: "c", name: "boom", phase: "failed", error: "kaboom" });
  });

  test("the cursor emits each frame exactly once across re-yielded accumulated state", () => {
    const step1 = [aiIds([{ name: "search", id: "c1" }])];
    const step2 = [...step1, toolResult({ tool_call_id: "c1", name: "search", content: "hits" })];
    const step3 = [...step2, aiIds([])]; // final answer

    let cursor = 0;
    const phases: string[] = [];
    for (const state of [step1, step2, step3]) {
      for (const f of extractToolFrames(state, cursor)) phases.push(`${f.name}:${f.phase}`);
      cursor = state.length;
    }
    expect(phases).toEqual(["search:started", "search:completed"]);
  });

  test("synthesizes a stable toolCallId when the provider omits ids", () => {
    const frames = extractToolFrames([aiIds([{ name: "t" }])], 0);
    expect(frames[0].toolCallId).toBe("t#0.0");
    expect(frames[0].phase).toBe("started");
  });
});

import { describe, test, expect } from "bun:test";
import { humanizeToolProgress } from "../agent-runtime-plugin.ts";

// #777: tool calls become a human progress line that a2a-server surfaces on
// streaming `working` updates (status.message), so A2A clients narrate real
// steps instead of bare heartbeats.

describe("humanizeToolProgress", () => {
  test("chat_with_agent names the target → 'routing to <agent>'", () => {
    expect(humanizeToolProgress([{ name: "chat_with_agent", args: { agent: "quinn" } }])).toBe("routing to quinn");
    expect(humanizeToolProgress([{ name: "delegate_task", args: { target: "roxy" } }])).toBe("routing to roxy");
  });

  test("chat_with_agent without a target falls back", () => {
    expect(humanizeToolProgress([{ name: "chat_with_agent", args: {} }])).toBe("delegating to an agent");
  });

  test("known tools map to readable phrases", () => {
    expect(humanizeToolProgress([{ name: "searxng_search" }])).toBe("searching the web");
    expect(humanizeToolProgress([{ name: "huggingface_search" }])).toBe("searching HuggingFace");
    expect(humanizeToolProgress([{ name: "research_search" }])).toBe("searching the research knowledge base");
    expect(humanizeToolProgress([{ name: "linear_get_issue" }])).toBe("working with Linear");
  });

  test("unknown tool → 'running <name>'", () => {
    expect(humanizeToolProgress([{ name: "frobnicate" }])).toBe("running frobnicate");
  });

  test("self-narrating tools produce no progress text (no double-narration)", () => {
    expect(humanizeToolProgress([{ name: "send_update" }])).toBe("");
    expect(humanizeToolProgress([{ name: "msg_operator" }])).toBe("");
  });

  test("dedupes repeated phrases, preserves order", () => {
    expect(humanizeToolProgress([
      { name: "chat_with_agent", args: { agent: "quinn" } },
      { name: "searxng_search" },
      { name: "searxng_search" },
    ])).toBe("routing to quinn; searching the web");
  });

  test("empty calls → empty string", () => {
    expect(humanizeToolProgress([])).toBe("");
  });
});

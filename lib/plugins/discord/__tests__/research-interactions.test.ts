import { describe, test, expect } from "bun:test";
import { InMemoryEventBus } from "../../../bus.ts";
import type { BusMessage } from "../../../types.ts";
import { RESEARCH_EMOJI, researchThreadName, dispatchResearch } from "../inbound.ts";
import type { DiscordContext } from "../core.ts";

describe("researchThreadName", () => {
  test("prefixes the 🔬 marker and uses the first line", () => {
    const n = researchThreadName("What is Mamba?\nsecond line ignored");
    expect(n.startsWith(`${RESEARCH_EMOJI} `)).toBe(true);
    expect(n).toBe("🔬 What is Mamba?");
  });
  test("truncates to <=95 chars and falls back when empty", () => {
    expect(researchThreadName("x".repeat(200)).length).toBeLessThanOrEqual(95);
    expect(researchThreadName("   ")).toBe("🔬 Research");
  });
});

describe("dispatchResearch", () => {
  function fakeCtx(bus: InMemoryEventBus): DiscordContext {
    return { bus, pendingAgents: new Map() } as unknown as DiscordContext;
  }

  test("publishes a deep_research request to the researcher, replying into the thread", () => {
    const bus = new InMemoryEventBus();
    const ctx = fakeCtx(bus);
    const seen: BusMessage[] = [];
    bus.subscribe("agent.skill.request", "t", (m) => { seen.push(m); });

    dispatchResearch(ctx, {
      channelId: "thread-123",
      correlationId: "corr-1",
      contextId: "discord-research-thread-123",
      userId: "u1",
      content: "what is RAG?",
      contextPreamble: "[Conversation context]\n…",
    });

    expect(seen).toHaveLength(1);
    const p = seen[0].payload as Record<string, unknown>;
    expect(p.skill).toBe("deep_research");
    expect(p.targets).toEqual(["researcher"]);
    expect(p.contextId).toBe("discord-research-thread-123");
    expect(p.content).toBe("what is RAG?");
    expect(p.contextPreamble).toContain("Conversation context");
    expect(seen[0].reply?.topic).toBe("message.outbound.discord.thread-123");
    expect(seen[0].correlationId).toBe("corr-1");
    // researcher registered as the pending agent for reply routing
    expect((ctx.pendingAgents as Map<string, string>).get("corr-1")).toBe("researcher");
  });

  test("sticky contextId ties multiple turns to one researcher conversation", () => {
    const bus = new InMemoryEventBus();
    const ctx = fakeCtx(bus);
    const ids: string[] = [];
    bus.subscribe("agent.skill.request", "t", (m) => { ids.push((m.payload as { contextId: string }).contextId); });
    const base = { channelId: "thr-9", contextId: "discord-research-thr-9", userId: "u1", contextPreamble: "" };
    dispatchResearch(ctx, { ...base, correlationId: "c1", content: "turn 1" });
    dispatchResearch(ctx, { ...base, correlationId: "c2", content: "turn 2" });
    // distinct correlationIds, same sticky contextId → one memory-backed thread
    expect(ids).toEqual(["discord-research-thr-9", "discord-research-thr-9"]);
  });

  test("empty content falls back to a sensible default", () => {
    const bus = new InMemoryEventBus();
    const ctx = fakeCtx(bus);
    let payload: Record<string, unknown> = {};
    bus.subscribe("agent.skill.request", "t", (m) => { payload = m.payload as Record<string, unknown>; });
    dispatchResearch(ctx, { channelId: "c", correlationId: "x", contextId: "discord-research-c", userId: "u", content: "", contextPreamble: "" });
    expect(payload.content).toBe("(research the referenced message)");
    expect(payload.contextPreamble).toBeUndefined();
  });
});

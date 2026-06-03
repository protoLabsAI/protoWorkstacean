import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../conversation-store.ts";
import { KnowledgeStore } from "../knowledge-store.ts";
import { AgentMemory } from "../agent-memory.ts";
import { ConversationHarvester, renderTranscript } from "../conversation-harvester.ts";

let dir: string;
let mem: AgentMemory;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harvest-test-"));
  const db = join(dir, "knowledge.db");
  mem = new AgentMemory(new ConversationStore(db), new KnowledgeStore(db));
  mem.init();
});
afterEach(() => {
  mem.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("renderTranscript", () => {
  test("renders User/Assistant lines, skips blanks", () => {
    const t = renderTranscript([
      { role: "user", content: "hello" },
      { role: "assistant", content: "  " },
      { role: "assistant", content: "hi there" },
    ]);
    expect(t).toBe("User: hello\nAssistant: hi there");
  });
});

describe("ConversationHarvester.sweepOnce", () => {
  test("summarizes aged conversations into the KB and reclaims the turns", async () => {
    mem.record("old-conv", { agent: "ava", skill: "chat", userText: "what's the deploy story?", aiText: "Watchtower auto-pulls :main. Workspace config deploys via git pull." });

    let summarizeCalls = 0;
    const harvester = new ConversationHarvester(mem, {
      summarize: async (transcript) => { summarizeCalls++; expect(transcript).toContain("deploy"); return "Summary: deploy via watchtower + git pull config."; },
      maxAgeMs: 0,
      now: () => Date.now() + 10_000, // everything is "aged"
    });

    const n = await harvester.sweepOnce();
    expect(n).toBe(1);
    expect(summarizeCalls).toBe(1);
    // raw turns reclaimed
    expect(mem.conversations.recentTurns("old-conv")).toEqual([]);
    // summary searchable in the conversation domain
    const hits = mem.knowledge.search("watchtower deploy", 5, "conversation");
    expect(hits.length).toBe(1);
    expect(hits[0].content).toContain("watchtower");
  });

  test("does not harvest conversations newer than maxAge", async () => {
    mem.record("fresh", { agent: "ava", skill: "chat", userText: "hi", aiText: "a reasonably long answer ".repeat(6) });
    const harvester = new ConversationHarvester(mem, {
      summarize: async () => "should not be called",
      maxAgeMs: 24 * 60 * 60_000, // 1 day
      now: () => Date.now(), // fresh conv is well within the day
    });
    const n = await harvester.sweepOnce();
    expect(n).toBe(0);
    expect(mem.conversations.recentTurns("fresh").length).toBe(2);
  });

  test("a summarizer failure leaves the conversation in place to retry", async () => {
    mem.record("err-conv", { agent: "ava", skill: "chat", userText: "q", aiText: "an answer long enough to be a finding ".repeat(4) });
    const harvester = new ConversationHarvester(mem, {
      summarize: async () => { throw new Error("LLM down"); },
      maxAgeMs: 0,
      now: () => Date.now() + 10_000,
    });
    const n = await harvester.sweepOnce();
    expect(n).toBe(0);
    // turns NOT reclaimed — retried next sweep
    expect(mem.conversations.recentTurns("err-conv").length).toBe(2);
  });
});

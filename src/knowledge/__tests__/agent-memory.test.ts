import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../conversation-store.ts";
import { KnowledgeStore } from "../knowledge-store.ts";
import { AgentMemory, memoryAppliesTo } from "../agent-memory.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mem-test-"));
  dbPath = join(dir, "knowledge.db");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ConversationStore", () => {
  test("appends turns and replays them chronologically (most-recent N)", () => {
    const s = new ConversationStore(dbPath);
    s.init();
    s.appendTurn("ctx1", "user", "hello", "ava", "chat");
    s.appendTurn("ctx1", "assistant", "hi there", "ava", "chat");
    s.appendTurn("ctx1", "user", "what's up", "ava", "chat");
    const turns = s.recentTurns("ctx1", 10);
    expect(turns).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "what's up" },
    ]);
    // limit returns the most-recent tail, still chronological
    expect(s.recentTurns("ctx1", 1)).toEqual([{ role: "user", content: "what's up" }]);
    s.close();
  });

  test("isolates conversations by contextId", () => {
    const s = new ConversationStore(dbPath);
    s.init();
    s.appendTurn("a", "user", "in a", "ava");
    s.appendTurn("b", "user", "in b", "ava");
    expect(s.recentTurns("a")).toEqual([{ role: "user", content: "in a" }]);
    expect(s.recentTurns("b")).toEqual([{ role: "user", content: "in b" }]);
    s.close();
  });

  test("retirable() finds conversations older than maxAge; deleteConversation clears them", () => {
    const s = new ConversationStore(dbPath);
    s.init();
    s.appendTurn("old", "user", "stale", "ava");
    s.appendTurn("fresh", "user", "recent", "ava");
    // Everything is "now"; with maxAge 0 and now in the future, all are retirable.
    const retirable = s.retirable(0, Date.now() + 1000);
    expect(retirable.map(r => r.contextId).sort()).toEqual(["fresh", "old"]);
    s.deleteConversation("old");
    expect(s.recentTurns("old")).toEqual([]);
    expect(s.recentTurns("fresh").length).toBe(1);
    s.close();
  });
});

describe("KnowledgeStore", () => {
  test("addChunk + search returns BM25/LIKE hits", () => {
    const k = new KnowledgeStore(dbPath);
    k.init();
    k.addChunk("The deploy pipeline uses watchtower to auto-pull the main image.", { domain: "finding", heading: "deploy" });
    k.addChunk("Roxy is the portfolio manager agent on the protoMaker board.", { domain: "finding", heading: "roxy" });
    const hits = k.search("watchtower deploy", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain("watchtower");
    k.close();
  });

  test("getHotMemory concatenates domain=hot chunks", () => {
    const k = new KnowledgeStore(dbPath);
    k.init();
    k.addChunk("Always greet the operator as Josh.", { domain: "hot" });
    k.addChunk("Never push directly to main.", { domain: "hot" });
    const hot = k.getHotMemory();
    expect(hot).toContain("Josh");
    expect(hot).toContain("main");
    // non-hot chunk excluded
    k.addChunk("some finding", { domain: "finding" });
    expect(k.getHotMemory()).not.toContain("some finding");
    k.close();
  });

  test("search scoped to a domain", () => {
    const k = new KnowledgeStore(dbPath);
    k.init();
    k.addChunk("alpha bravo charlie", { domain: "conversation" });
    k.addChunk("alpha bravo delta", { domain: "finding" });
    const conv = k.search("alpha", 5, "conversation");
    expect(conv.every(h => h.domain === "conversation")).toBe(true);
    expect(conv.length).toBe(1);
    k.close();
  });
});

describe("AgentMemory", () => {
  test("record persists turns and extracts a finding for substantive answers", () => {
    const mem = new AgentMemory(new ConversationStore(dbPath), new KnowledgeStore(dbPath));
    mem.init();
    const longAnswer = "The release cadence stalled at v0.7.22; we cut v0.8.0 and standardized release-tools. ".repeat(2);
    mem.record("ctx1", { agent: "ava", skill: "chat", userText: "what's our release status?", aiText: longAnswer });
    // turn history present
    const h = mem.history("ctx1");
    expect(h.length).toBe(2);
    expect(h[0]).toEqual({ role: "user", content: "what's our release status?" });
    // finding searchable
    const block = mem.recallBlock("release cadence v0.8.0");
    expect(block).toContain("Relevant context");
    expect(block).toContain("v0.8.0");
    mem.close();
  });

  test("short answers are not stored as findings", () => {
    const mem = new AgentMemory(new ConversationStore(dbPath), new KnowledgeStore(dbPath));
    mem.init();
    mem.record("ctx1", { agent: "ava", skill: "chat", userText: "hi", aiText: "hey" });
    // history still recorded, but no finding chunk → recall finds nothing
    expect(mem.history("ctx1").length).toBe(2);
    expect(mem.recallBlock("hey")).toBe("");
    mem.close();
  });

  test("recallBlock includes hot memory", () => {
    const mem = new AgentMemory(new ConversationStore(dbPath), new KnowledgeStore(dbPath));
    mem.init();
    mem.knowledge.addChunk("Operator is Josh.", { domain: "hot" });
    expect(mem.recallBlock("anything")).toContain("Always-on facts");
    mem.close();
  });
});

describe("memoryAppliesTo", () => {
  test("off when disabled or undefined", () => {
    expect(memoryAppliesTo(undefined, "chat")).toBe(false);
    expect(memoryAppliesTo({ enabled: false }, "chat")).toBe(false);
  });
  test("default skill set is [chat]", () => {
    expect(memoryAppliesTo({ enabled: true }, "chat")).toBe(true);
    expect(memoryAppliesTo({ enabled: true }, undefined)).toBe(true); // undefined ⇒ chat
    expect(memoryAppliesTo({ enabled: true }, "pr_review")).toBe(false);
  });
  test("honors explicit skills list", () => {
    expect(memoryAppliesTo({ enabled: true, skills: ["chat", "triage"] }, "triage")).toBe(true);
    expect(memoryAppliesTo({ enabled: true, skills: ["triage"] }, "chat")).toBe(false);
  });
});

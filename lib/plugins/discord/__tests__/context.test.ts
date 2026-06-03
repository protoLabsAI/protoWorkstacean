import { describe, test, expect } from "bun:test";
import type { Message } from "discord.js";
import { buildMessageContext } from "../context.ts";

/** Minimal structural fake of a discord.js Message for the fields context.ts reads. */
function fakeMessage(opts: {
  id?: string;
  cleanContent?: string;
  displayName?: string;
  reference?: { messageId: string };
  fetchReference?: () => Promise<Message>;
  isThread?: boolean;
  starter?: Message | null;
  threadName?: string;
  scrollback?: Message[];
  attachments?: { name: string; url: string }[];
}): Message {
  const attachments = new Map((opts.attachments ?? []).map((a, i) => [String(i), a]));
  const channel: Record<string, unknown> = {
    isThread: () => !!opts.isThread,
    name: opts.threadName,
    fetchStarterMessage: async () => opts.starter ?? null,
    messages: {
      fetch: async () => new Map((opts.scrollback ?? []).map((m, i) => [String(i), m])),
    },
  };
  return {
    id: opts.id ?? "m1",
    cleanContent: opts.cleanContent ?? "",
    member: opts.displayName ? { displayName: opts.displayName } : null,
    author: { username: "user", globalName: opts.displayName },
    reference: opts.reference,
    fetchReference: opts.fetchReference ?? (async () => { throw new Error("no ref"); }),
    channel,
    attachments,
  } as unknown as Message;
}

describe("buildMessageContext", () => {
  test("returns '' when there's no surrounding context", async () => {
    const m = fakeMessage({ cleanContent: "just a plain message" });
    expect(await buildMessageContext(m)).toBe("");
  });

  test("includes the replied-to message", async () => {
    const ref = fakeMessage({ cleanContent: "the original question about deploys", displayName: "Josh" });
    const m = fakeMessage({
      reference: { messageId: "ref1" },
      fetchReference: async () => ref,
    });
    const ctx = await buildMessageContext(m);
    expect(ctx).toContain("[Conversation context]");
    expect(ctx).toContain("replying to Josh");
    expect(ctx).toContain("original question about deploys");
  });

  test("includes recent channel scrollback, oldest-first", async () => {
    const older = fakeMessage({ cleanContent: "first message", displayName: "Alice" });
    const newer = fakeMessage({ cleanContent: "second message", displayName: "Bob" });
    // fetch returns newest-first (Discord order); builder reverses to chronological.
    const m = fakeMessage({ scrollback: [newer, older] });
    const ctx = await buildMessageContext(m);
    expect(ctx).toContain("Recent messages in this channel");
    expect(ctx.indexOf("first message")).toBeLessThan(ctx.indexOf("second message"));
    expect(ctx).toContain("Alice:");
  });

  test("includes thread context", async () => {
    const starter = fakeMessage({ cleanContent: "thread kickoff topic", displayName: "Josh" });
    const m = fakeMessage({ isThread: true, threadName: "Memory work", starter });
    const ctx = await buildMessageContext(m);
    expect(ctx).toContain('Thread "Memory work"');
    expect(ctx).toContain("thread kickoff topic");
  });

  test("lists attachments", async () => {
    const m = fakeMessage({ attachments: [{ name: "trace.log", url: "http://x/trace.log" }] });
    const ctx = await buildMessageContext(m);
    expect(ctx).toContain("Attachments on this message: trace.log");
  });

  test("degrades when fetchReference throws", async () => {
    const m = fakeMessage({
      reference: { messageId: "gone" },
      fetchReference: async () => { throw new Error("uncached"); },
      cleanContent: "reply to a deleted message",
    });
    // No throw; reply line simply omitted.
    expect(await buildMessageContext(m)).toBe("");
  });
});

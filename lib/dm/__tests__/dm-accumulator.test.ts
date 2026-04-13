import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DmAccumulator, type AccumulatorEntry, type AccumulatorMessage } from "../dm-accumulator.ts";
import { ContextMailbox } from "../context-mailbox.ts";

function makeMessage(id: string = "msg-1"): AccumulatorMessage {
  return { id, channelId: "dm-channel-1" };
}

const DEBOUNCE = 80; // short for tests

describe("DmAccumulator", () => {
  let accumulator: DmAccumulator;
  let flushed: Omit<AccumulatorEntry, "timer">[];
  let mailbox: ContextMailbox;

  beforeEach(() => {
    flushed = [];
    mailbox = new ContextMailbox({ ttlMs: 60_000, sweepIntervalMs: 60_000 });
    accumulator = new DmAccumulator({
      debounceMs: DEBOUNCE,
      onFlush: (entry) => { flushed.push(entry); },
      fallbackMailbox: mailbox,
    });
  });

  afterEach(() => {
    accumulator.destroy();
    mailbox.destroy();
  });

  function push(content: string, conversationId = "conv-1", messageId?: string) {
    return accumulator.push({
      conversationId,
      userId: "user-1",
      channelId: "dm-channel-1",
      agentName: "ava",
      message: makeMessage(messageId ?? `msg-${content}`),
      content,
      turnNumber: 1,
      isNew: true,
    });
  }

  it("single message dispatches after debounce timer", async () => {
    push("hello");
    expect(flushed).toHaveLength(0);

    await new Promise(r => setTimeout(r, DEBOUNCE + 30));
    expect(flushed).toHaveLength(1);
    expect(flushed[0].contents).toEqual(["hello"]);
  });

  it("multiple messages within window are batched", async () => {
    push("one");
    push("two");
    push("three");

    await new Promise(r => setTimeout(r, DEBOUNCE + 30));
    expect(flushed).toHaveLength(1);
    expect(flushed[0].contents).toEqual(["one", "two", "three"]);
  });

  it("timer resets on each push", async () => {
    push("first");
    await new Promise(r => setTimeout(r, DEBOUNCE - 20));

    // Push again before timer fires — should reset
    push("second");
    await new Promise(r => setTimeout(r, DEBOUNCE - 20));

    // Still shouldn't have flushed (timer reset)
    expect(flushed).toHaveLength(0);

    await new Promise(r => setTimeout(r, 40));
    expect(flushed).toHaveLength(1);
    expect(flushed[0].contents).toEqual(["first", "second"]);
  });

  it("different conversations are independent", async () => {
    push("conv-a msg", "conv-a");
    push("conv-b msg", "conv-b");

    await new Promise(r => setTimeout(r, DEBOUNCE + 30));
    expect(flushed).toHaveLength(2);
    const ids = flushed.map(f => f.conversationId).sort();
    expect(ids).toEqual(["conv-a", "conv-b"]);
  });

  it("push returns true only for first message in batch", () => {
    expect(push("first")).toBe(true);
    expect(push("second")).toBe(false);
    expect(push("third")).toBe(false);
  });

  it("stores lastMessage from most recent push", async () => {
    push("first", "conv-1", "msg-001");
    push("second", "conv-1", "msg-002");
    push("third", "conv-1", "msg-003");

    await new Promise(r => setTimeout(r, DEBOUNCE + 30));
    expect(flushed[0].lastMessage.id).toBe("msg-003");
  });

  it("cancel prevents flush", async () => {
    push("will be cancelled");
    accumulator.cancel("conv-1");

    await new Promise(r => setTimeout(r, DEBOUNCE + 30));
    expect(flushed).toHaveLength(0);
  });

  it("destroy cancels all pending", async () => {
    push("a", "conv-a");
    push("b", "conv-b");
    push("c", "conv-c");
    accumulator.destroy();

    await new Promise(r => setTimeout(r, DEBOUNCE + 30));
    expect(flushed).toHaveLength(0);
  });

  it("pending getter reflects active entries", async () => {
    expect(accumulator.pending).toBe(0);
    push("a", "conv-a");
    push("b", "conv-b");
    expect(accumulator.pending).toBe(2);

    await new Promise(r => setTimeout(r, DEBOUNCE + 30));
    expect(accumulator.pending).toBe(0);
  });

  it("preserves isNew from first push only", async () => {
    accumulator.push({
      conversationId: "conv-1",
      userId: "user-1",
      channelId: "dm-channel-1",
      agentName: "ava",
      message: makeMessage(),
      content: "first",
      turnNumber: 1,
      isNew: true,
    });
    accumulator.push({
      conversationId: "conv-1",
      userId: "user-1",
      channelId: "dm-channel-1",
      agentName: "ava",
      message: makeMessage("msg-2"),
      content: "second",
      turnNumber: 2,
      isNew: false,
    });

    await new Promise(r => setTimeout(r, DEBOUNCE + 30));
    expect(flushed[0].isNew).toBe(true);
  });

  describe("error handling", () => {
    it("catches sync flush errors and pushes to fallback mailbox", async () => {
      const errorAccumulator = new DmAccumulator({
        debounceMs: DEBOUNCE,
        onFlush: () => { throw new Error("flush failed"); },
        fallbackMailbox: mailbox,
      });

      errorAccumulator.push({
        conversationId: "conv-err",
        userId: "user-1",
        channelId: "dm-channel-1",
        agentName: undefined,
        message: makeMessage(),
        content: "important message",
        turnNumber: 1,
        isNew: true,
      });

      await new Promise(r => setTimeout(r, DEBOUNCE + 30));

      // Message should be in fallback mailbox
      expect(mailbox.has("conv-err")).toBe(true);
      const drained = mailbox.drain("conv-err");
      expect(drained).toHaveLength(1);
      expect(drained[0].content).toBe("important message");

      errorAccumulator.destroy();
    });

    it("catches async flush errors and pushes to fallback mailbox", async () => {
      const errorAccumulator = new DmAccumulator({
        debounceMs: DEBOUNCE,
        onFlush: async () => { throw new Error("async flush failed"); },
        fallbackMailbox: mailbox,
      });

      errorAccumulator.push({
        conversationId: "conv-err-async",
        userId: "user-1",
        channelId: "dm-channel-1",
        agentName: undefined,
        message: makeMessage(),
        content: "async important",
        turnNumber: 1,
        isNew: true,
      });

      await new Promise(r => setTimeout(r, DEBOUNCE + 60));

      expect(mailbox.has("conv-err-async")).toBe(true);
      const drained = mailbox.drain("conv-err-async");
      expect(drained[0].content).toBe("async important");

      errorAccumulator.destroy();
    });
  });
});

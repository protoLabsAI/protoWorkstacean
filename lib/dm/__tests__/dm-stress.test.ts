/**
 * Stress tests for DM debounce + context mailbox under load.
 *
 * Scenarios covered:
 *   1. Rapid-fire DMs from one user — batching integrity
 *   2. Concurrent DMs from multiple users — isolation
 *   3. Mailbox drain while new messages arrive — no drops
 *   4. Mailbox under TTL pressure — old messages expire, new survive
 *   5. Flush callback slow (async) — timer doesn't fire twice for same conversation
 *   6. Flush error fallback — messages survive via fallback mailbox
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DmAccumulator, type AccumulatorEntry, type AccumulatorMessage } from "../dm-accumulator.ts";
import { ContextMailbox } from "../context-mailbox.ts";

function makeMessage(id: string, channelId = "dm-channel-1"): AccumulatorMessage {
  return { id, channelId };
}

function makePush(accumulator: DmAccumulator, conv: string, user: string, content: string) {
  return accumulator.push({
    conversationId: conv,
    userId: user,
    channelId: `channel-${user}`,
    agentName: "ava",
    message: makeMessage(`${conv}-${content}`),
    content,
    turnNumber: 1,
    isNew: true,
  });
}

const DEBOUNCE = 50;

describe("DM stress", () => {
  let accumulator: DmAccumulator;
  let mailbox: ContextMailbox;
  let flushed: Omit<AccumulatorEntry, "timer">[];

  beforeEach(() => {
    flushed = [];
    mailbox = new ContextMailbox({ ttlMs: 5_000, sweepIntervalMs: 5_000 });
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

  it("rapid-fire 20 messages from same user batch into single flush", async () => {
    for (let i = 0; i < 20; i++) {
      makePush(accumulator, "conv-1", "user-1", `msg-${i}`);
    }
    await new Promise(r => setTimeout(r, DEBOUNCE + 30));
    expect(flushed).toHaveLength(1);
    expect(flushed[0].contents).toHaveLength(20);
  });

  it("concurrent conversations from 10 users stay isolated", async () => {
    for (let u = 0; u < 10; u++) {
      for (let i = 0; i < 5; i++) {
        makePush(accumulator, `conv-${u}`, `user-${u}`, `u${u}-m${i}`);
      }
    }
    await new Promise(r => setTimeout(r, DEBOUNCE + 50));
    expect(flushed).toHaveLength(10);
    for (const entry of flushed) {
      expect(entry.contents).toHaveLength(5);
      // each entry's contents all start with same user prefix
      const prefix = entry.contents[0].split("-")[0];
      expect(entry.contents.every(c => c.startsWith(prefix))).toBe(true);
    }
  });

  it("extremely rapid fire (0ms spacing, 50 messages) never loses content", async () => {
    for (let i = 0; i < 50; i++) makePush(accumulator, "conv-1", "user-1", String(i));
    await new Promise(r => setTimeout(r, DEBOUNCE + 30));
    expect(flushed).toHaveLength(1);
    // All 50 messages should be accounted for
    const numbers = flushed[0].contents.map(Number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("mailbox push+drain under load — no races, no drops", async () => {
    // Simulate 100 messages interleaved between push and drain
    for (let i = 0; i < 50; i++) {
      mailbox.push(`conv-${i % 5}`, {
        content: `msg-${i}`,
        receivedAt: Date.now(),
      });
    }
    // Drain 3 of 5 conversations
    const drained1 = mailbox.drain("conv-0");
    const drained2 = mailbox.drain("conv-1");
    const drained3 = mailbox.drain("conv-2");

    // Push more into the drained slots
    for (let i = 0; i < 20; i++) {
      mailbox.push(`conv-${i % 3}`, { content: `after-${i}`, receivedAt: Date.now() });
    }

    // Drain all
    const final0 = mailbox.drain("conv-0");
    const final1 = mailbox.drain("conv-1");
    const final2 = mailbox.drain("conv-2");
    const stillThere3 = mailbox.drain("conv-3");
    const stillThere4 = mailbox.drain("conv-4");

    // Total drained should equal total pushed (50 + 20 = 70)
    const total =
      drained1.length + drained2.length + drained3.length +
      final0.length + final1.length + final2.length +
      stillThere3.length + stillThere4.length;
    expect(total).toBe(70);
  });

  it("rapid debounce-reset storm — timer stability", async () => {
    // Push every 10ms for ~200ms — each push resets the timer
    for (let i = 0; i < 15; i++) {
      makePush(accumulator, "conv-1", "user-1", `msg-${i}`);
      await new Promise(r => setTimeout(r, 10));
    }
    // Still haven't flushed because timer kept resetting
    expect(flushed).toHaveLength(0);

    // Now stop pushing and wait for the debounce to fire once
    await new Promise(r => setTimeout(r, DEBOUNCE + 30));
    expect(flushed).toHaveLength(1);
    expect(flushed[0].contents).toHaveLength(15);
  });

  it("slow async flush — doesn't allow duplicate entries", async () => {
    const slowAccumulator = new DmAccumulator({
      debounceMs: DEBOUNCE,
      onFlush: async () => {
        await new Promise(r => setTimeout(r, 100));
      },
    });

    // Push a message, let flush fire and start processing
    makePush(slowAccumulator, "conv-1", "user-1", "first");
    await new Promise(r => setTimeout(r, DEBOUNCE + 5));

    // While flush is still running, push another — should start a NEW entry
    makePush(slowAccumulator, "conv-1", "user-1", "second");

    // The second push creates a new entry because the first was already deleted on flush
    expect(slowAccumulator.pending).toBe(1);

    await new Promise(r => setTimeout(r, 200));
    slowAccumulator.destroy();
  });

  it("TTL expiration under load — old messages drop, new survive", async () => {
    const shortMailbox = new ContextMailbox({ ttlMs: 50, sweepIntervalMs: 25 });
    try {
      // Push 10 old messages
      for (let i = 0; i < 10; i++) {
        shortMailbox.push(`conv-old-${i}`, { content: `old-${i}`, receivedAt: Date.now() });
      }
      // Wait for TTL
      await new Promise(r => setTimeout(r, 100));
      // Push 10 new ones
      for (let i = 0; i < 10; i++) {
        shortMailbox.push(`conv-new-${i}`, { content: `new-${i}`, receivedAt: Date.now() });
      }

      // Old ones should all be expired
      for (let i = 0; i < 10; i++) {
        expect(shortMailbox.drain(`conv-old-${i}`)).toHaveLength(0);
      }
      // New ones should survive
      for (let i = 0; i < 10; i++) {
        const drained = shortMailbox.drain(`conv-new-${i}`);
        expect(drained).toHaveLength(1);
      }
    } finally {
      shortMailbox.destroy();
    }
  });

  it("fallback mailbox activates on flush error — no message loss", async () => {
    const errorAccumulator = new DmAccumulator({
      debounceMs: DEBOUNCE,
      onFlush: () => { throw new Error("flush boom"); },
      fallbackMailbox: mailbox,
    });

    try {
      for (let i = 0; i < 5; i++) {
        makePush(errorAccumulator, "conv-err", "user-1", `err-${i}`);
      }

      await new Promise(r => setTimeout(r, DEBOUNCE + 30));

      // Flush threw, so fallback mailbox should have the content
      expect(mailbox.has("conv-err")).toBe(true);
      const drained = mailbox.drain("conv-err");
      expect(drained).toHaveLength(1);
      // All 5 messages joined in one mailbox entry
      expect(drained[0].content).toContain("[1/5]");
      expect(drained[0].content).toContain("[5/5]");
    } finally {
      errorAccumulator.destroy();
    }
  });

  it("mailbox handles 1000 contextIds without degradation", async () => {
    for (let i = 0; i < 1000; i++) {
      mailbox.push(`conv-${i}`, { content: `msg`, receivedAt: Date.now() });
    }
    expect(mailbox.size).toBe(1000);

    // Drain half
    for (let i = 0; i < 500; i++) mailbox.drain(`conv-${i}`);
    expect(mailbox.size).toBe(500);

    // Format still works on large batches
    const big = Array.from({ length: 100 }, (_, i) => ({
      content: `m${i}`,
      receivedAt: Date.now(),
    }));
    const formatted = ContextMailbox.format(big);
    expect(formatted).toContain("[1/100]");
    expect(formatted).toContain("[100/100]");
  });
});

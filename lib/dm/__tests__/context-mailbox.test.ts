import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ContextMailbox, type MailboxMessage } from "../context-mailbox.ts";

function msg(content: string, sender?: string): MailboxMessage {
  return { content, sender, receivedAt: Date.now() };
}

describe("ContextMailbox", () => {
  let mailbox: ContextMailbox;

  beforeEach(() => {
    mailbox = new ContextMailbox({ ttlMs: 60_000, sweepIntervalMs: 60_000 });
  });

  afterEach(() => {
    mailbox.destroy();
  });

  it("push + drain returns messages in order", () => {
    mailbox.push("ctx-1", msg("first"));
    mailbox.push("ctx-1", msg("second"));
    mailbox.push("ctx-1", msg("third"));

    const drained = mailbox.drain("ctx-1");
    expect(drained).toHaveLength(3);
    expect(drained[0].content).toBe("first");
    expect(drained[1].content).toBe("second");
    expect(drained[2].content).toBe("third");
  });

  it("drain is destructive — second drain returns empty", () => {
    mailbox.push("ctx-1", msg("hello"));

    expect(mailbox.drain("ctx-1")).toHaveLength(1);
    expect(mailbox.drain("ctx-1")).toHaveLength(0);
  });

  it("peek is non-destructive", () => {
    mailbox.push("ctx-1", msg("hello"));

    expect(mailbox.peek("ctx-1")).toHaveLength(1);
    expect(mailbox.peek("ctx-1")).toHaveLength(1);
    expect(mailbox.drain("ctx-1")).toHaveLength(1);
  });

  it("has() reflects pending state", () => {
    expect(mailbox.has("ctx-1")).toBe(false);
    mailbox.push("ctx-1", msg("hello"));
    expect(mailbox.has("ctx-1")).toBe(true);
    mailbox.drain("ctx-1");
    expect(mailbox.has("ctx-1")).toBe(false);
  });

  it("size reflects distinct contextIds", () => {
    expect(mailbox.size).toBe(0);
    mailbox.push("ctx-1", msg("a"));
    mailbox.push("ctx-2", msg("b"));
    mailbox.push("ctx-3", msg("c"));
    expect(mailbox.size).toBe(3);
    mailbox.drain("ctx-2");
    expect(mailbox.size).toBe(2);
  });

  it("drain on unknown contextId returns empty array", () => {
    expect(mailbox.drain("nonexistent")).toEqual([]);
  });

  it("peek on unknown contextId returns empty array", () => {
    expect(mailbox.peek("nonexistent")).toEqual([]);
  });

  describe("TTL expiration", () => {
    it("sweep removes expired messages", async () => {
      const shortMailbox = new ContextMailbox({ ttlMs: 50, sweepIntervalMs: 30 });
      try {
        shortMailbox.push("ctx-1", msg("will expire"));
        await new Promise(r => setTimeout(r, 120));
        expect(shortMailbox.drain("ctx-1")).toHaveLength(0);
      } finally {
        shortMailbox.destroy();
      }
    });

    it("sweep keeps live messages", async () => {
      const shortMailbox = new ContextMailbox({ ttlMs: 500, sweepIntervalMs: 30 });
      try {
        shortMailbox.push("ctx-1", msg("will survive"));
        await new Promise(r => setTimeout(r, 60));
        expect(shortMailbox.drain("ctx-1")).toHaveLength(1);
      } finally {
        shortMailbox.destroy();
      }
    });
  });

  describe("format()", () => {
    it("returns empty string for no messages", () => {
      expect(ContextMailbox.format([])).toBe("");
    });

    it("returns raw content for single message", () => {
      expect(ContextMailbox.format([msg("just one")])).toBe("just one");
    });

    it("returns numbered format for multiple messages", () => {
      const formatted = ContextMailbox.format([
        msg("check the tests"),
        msg("the failing one is in auth.test.ts"),
        msg("also fix the types"),
      ]);
      expect(formatted).toContain("[User sent additional messages while you were working]");
      expect(formatted).toContain("[1/3] check the tests");
      expect(formatted).toContain("[2/3] the failing one is in auth.test.ts");
      expect(formatted).toContain("[3/3] also fix the types");
    });

    it("numbered format preserves messages with blank lines", () => {
      const formatted = ContextMailbox.format([
        msg("line one\n\nline three"),
        msg("second message"),
      ]);
      expect(formatted).toContain("[1/2] line one\n\nline three");
      expect(formatted).toContain("[2/2] second message");
    });
  });
});

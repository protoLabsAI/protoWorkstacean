/**
 * Anti-thrash: budget-exhausted PR reviews (recursion limit / timeout) produce
 * no verdict. Rather than fail to silence, the github-outbound reply handler
 * escalates to a human and deliberately does NOT post a COMMENT (a COMMENTED
 * state would let approve-on-green auto-approve an unreviewed PR).
 *
 * Covers the pure gate plus the handler's escalate-vs-comment branch with a
 * stubbed GitHub API. See docs/explanation/code-review-agent-design.md.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isReviewBudgetExhausted, GitHubPlugin } from "../github.ts";
import { InMemoryEventBus } from "../../bus.ts";
import { ProjectRegistry } from "../../../src/plugins/project-registry.ts";

describe("isReviewBudgetExhausted", () => {
  test("true for recursion-limit + timeout signatures", () => {
    expect(isReviewBudgetExhausted("Recursion limit of 37 reached without hitting a stop condition. You can...")).toBe(true);
    expect(isReviewBudgetExhausted("The operation timed out.")).toBe(true);
    expect(isReviewBudgetExhausted("The operation was aborted")).toBe(true);
  });
  test("false for a real verdict or empty/undefined", () => {
    expect(isReviewBudgetExhausted("Submitted COMMENT review on protoLabsAI/ORBIS#253.")).toBe(false);
    expect(isReviewBudgetExhausted("")).toBe(false);
    expect(isReviewBudgetExhausted(undefined)).toBe(false);
  });
});

const PENDING = { owner: "protoLabsAI", repo: "ORBIS", number: 253 };

function drive(plugin: GitHubPlugin, payload: Record<string, unknown>, bus: InMemoryEventBus) {
  return (plugin as unknown as {
    _handleOutboundReply: (
      pending: typeof PENDING,
      cid: string,
      payload: Record<string, unknown>,
      bus: InMemoryEventBus,
      getToken: () => Promise<string>,
    ) => Promise<void>;
  })._handleOutboundReply(PENDING, "cid-1", payload, bus, async () => "fake-token");
}

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

describe("_handleOutboundReply — budget-exhaustion escalation", () => {
  test("recursion-limit error → escalates to operator, posts NO comment", async () => {
    const commentPosts: string[] = [];
    globalThis.fetch = (async (url: string) => {
      commentPosts.push(String(url));
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;

    const bus = new InMemoryEventBus();
    const escalations: Record<string, unknown>[] = [];
    bus.subscribe("operator.message.request", "test", (m) => { escalations.push(m.payload as Record<string, unknown>); });

    const plugin = new GitHubPlugin("/tmp/nonexistent-ws", new ProjectRegistry());
    await drive(plugin, { error: "Recursion limit of 37 reached without hitting a stop condition." }, bus);

    expect(escalations.length).toBe(1);
    expect(escalations[0]!.type).toBe("operator_message_request");
    expect(String(escalations[0]!.message)).toContain("protoLabsAI/ORBIS#253");
    expect(escalations[0]!.from).toBe("github");
    expect(commentPosts.length).toBe(0); // never posts a review/comment
  });

  test("normal content reply → posts a comment, no escalation", async () => {
    const commentPosts: string[] = [];
    globalThis.fetch = (async (url: string) => {
      commentPosts.push(String(url));
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;

    const bus = new InMemoryEventBus();
    const escalations: unknown[] = [];
    bus.subscribe("operator.message.request", "test", (m) => { escalations.push(m.payload); });

    const plugin = new GitHubPlugin("/tmp/nonexistent-ws", new ProjectRegistry());
    await drive(plugin, { content: "VERDICT: PASS — looks good." }, bus);

    expect(escalations.length).toBe(0);
    expect(commentPosts.length).toBe(1);
  });

  test("empty reply → no comment, no escalation", async () => {
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return new Response("{}", { status: 201 }); }) as unknown as typeof fetch;
    const bus = new InMemoryEventBus();
    const escalations: unknown[] = [];
    bus.subscribe("operator.message.request", "test", (m) => { escalations.push(m.payload); });

    const plugin = new GitHubPlugin("/tmp/nonexistent-ws", new ProjectRegistry());
    await drive(plugin, { content: "" }, bus);

    expect(escalations.length).toBe(0);
    expect(fetched).toBe(false);
  });
});

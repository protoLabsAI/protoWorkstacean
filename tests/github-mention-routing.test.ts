/**
 * @protoquinn mention routing — a top-level comment on a PR (issue_comment
 * event with issue.pull_request set) should route to pr_review, not the
 * default issue_comment skill (bug_triage).
 */

import { describe, test, expect, mock, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitHubPlugin } from "../lib/plugins/github.ts";
import type { EventBus, BusMessage } from "../lib/types.ts";

let workspaceDir: string;
let origFetch: typeof globalThis.fetch;

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "gh-mention-test-"));
});
afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

beforeEach(() => {
  // The mention path fires a fire-and-forget "eyes" reaction via global
  // fetch; stub it so the test never touches the network.
  origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

const config = {
  mentionHandle: "@protoquinn",
  admins: ["mabry1985"],
  skillHints: {
    issues: "bug_triage",
    issue_comment: "bug_triage",
    pull_request: "pr_review",
    pull_request_review_comment: "pr_review",
  },
};

function makeMockBus(): { bus: EventBus; published: Array<{ topic: string; msg: BusMessage }> } {
  const published: Array<{ topic: string; msg: BusMessage }> = [];
  const bus: EventBus = {
    publish: mock((topic: string, msg: BusMessage) => { published.push({ topic, msg }); }),
    subscribe: mock(() => "sub"),
    unsubscribe: mock(() => {}),
    topics: mock(() => []),
    consumers: mock(() => []),
  };
  return { bus, published };
}

const getToken = mock(async () => "tok");

function fire(payload: Record<string, unknown>) {
  const { bus, published } = makeMockBus();
  const plugin = new GitHubPlugin(workspaceDir);
  (plugin as unknown as { _handleEvent: Function })._handleEvent(
    "issue_comment", payload, config, bus, getToken,
  );
  return published;
}

function prCommentPayload(body: string, author = "mabry1985") {
  return {
    action: "created",
    issue: {
      number: 99,
      title: "Add the thing",
      html_url: "https://github.com/protoLabsAI/widget/pull/99",
      pull_request: { url: "https://api.github.com/repos/protoLabsAI/widget/pulls/99" },
    },
    comment: { id: 5, body, html_url: "https://github.com/...#c5", user: { login: author } },
    repository: { name: "widget", owner: { login: "protoLabsAI" } },
  };
}

describe("@protoquinn mention routing", () => {
  test("comment on a PR routes to pr_review (not bug_triage)", () => {
    const published = fire(prCommentPayload("@protoquinn please review this"));
    const skillReq = published.find((p) => p.topic.startsWith("message.inbound.github."));
    expect(skillReq).toBeDefined();
    expect((skillReq!.msg.payload as Record<string, unknown>).skillHint).toBe("pr_review");
  });

  test("comment on a plain issue still routes to bug_triage", () => {
    const issuePayload = {
      action: "created",
      issue: {
        number: 12,
        title: "Something is broken",
        html_url: "https://github.com/protoLabsAI/widget/issues/12",
        // no pull_request field → it's a real issue
      },
      comment: { id: 7, body: "@protoquinn take a look", html_url: "x", user: { login: "mabry1985" } },
      repository: { name: "widget", owner: { login: "protoLabsAI" } },
    };
    const published = fire(issuePayload);
    const skillReq = published.find((p) => p.topic.startsWith("message.inbound.github."));
    expect(skillReq).toBeDefined();
    expect((skillReq!.msg.payload as Record<string, unknown>).skillHint).toBe("bug_triage");
  });

  test("non-admin mention on a PR is ignored", () => {
    const published = fire(prCommentPayload("@protoquinn review", "random-user"));
    const skillReq = published.find((p) => p.topic.startsWith("message.inbound.github."));
    expect(skillReq).toBeUndefined();
  });
});

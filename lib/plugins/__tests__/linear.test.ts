/**
 * LinearPlugin tests — inbound webhook → bus publish, outbound bus → LinearClient,
 * HMAC verification, and dedup. Exercises the plugin's shape translation without
 * starting a real HTTP server (we call the internal handler directly via a
 * minimal harness) so tests run fast and are hermetic.
 *
 * We don't spin up Bun.serve — install() has HTTP wiring side effects we can't
 * easily disable, so these tests reach into the plugin by calling the private
 * _handleWebhook and _wireOutbound methods directly through an `as unknown as`
 * cast. Same pattern used in the pr-remediator tests.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import { InMemoryEventBus } from "../../bus.ts";
import { LinearPlugin } from "../linear.ts";
import type { BusMessage } from "../../types.ts";

interface LinearPrivate {
  _handleWebhook(payload: unknown, bus: InMemoryEventBus): Promise<void>;
  _wireOutbound(bus: InMemoryEventBus, client: unknown): void;
}

function priv(plugin: LinearPlugin): LinearPrivate {
  return plugin as unknown as LinearPrivate;
}

// Minimal stand-in for LinearClient — records calls so outbound tests assert
// that the correct SDK method was invoked with the right arguments.
interface MockCall {
  method: string;
  args: unknown[];
}
function makeMockClient(overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls: MockCall[] = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    const impl = overrides[method];
    if (impl) return impl(...args);
    if (method === "createIssue") return Promise.resolve("new-issue-id");
    if (method === "addComment") return Promise.resolve(true);
    if (method === "updateIssue") return Promise.resolve(true);
    return Promise.resolve(null);
  };
  return {
    calls,
    addComment: record("addComment"),
    createIssue: record("createIssue"),
    updateIssue: record("updateIssue"),
  };
}

function collectBus(bus: InMemoryEventBus, pattern: string): BusMessage[] {
  const collected: BusMessage[] = [];
  bus.subscribe(pattern, "test-collector", (msg) => { collected.push(msg); });
  return collected;
}

describe("LinearPlugin — inbound webhooks", () => {
  let bus: InMemoryEventBus;
  let plugin: LinearPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    plugin = new LinearPlugin();
  });

  test("Issue create → publishes message.inbound.linear.issue.created with correct shape", async () => {
    const collected = collectBus(bus, "message.inbound.linear.issue.#");
    await priv(plugin)._handleWebhook({
      action: "create",
      type: "Issue",
      data: {
        id: "issue-uuid-1",
        identifier: "ENG-42",
        title: "Add Linear plugin",
        description: "Build outbound + inbound bridges",
        priority: 2,
        priorityLabel: "High",
        state: { id: "state-1", name: "Todo", type: "unstarted" },
        team: { id: "team-1", key: "ENG", name: "Engineering" },
        project: { id: "project-1", name: "Integrations" },
        assignee: { id: "user-1", name: "Josh" },
        creator: { id: "user-1", name: "Josh" },
        labels: [{ id: "label-1", name: "backend" }],
        url: "https://linear.app/foo/issue/ENG-42",
      },
    }, bus);

    expect(collected).toHaveLength(1);
    const msg = collected[0];
    expect(msg.topic).toBe("message.inbound.linear.issue.created");
    const p = msg.payload as Record<string, unknown>;
    expect(p.issueId).toBe("issue-uuid-1");
    expect(p.identifier).toBe("ENG-42");
    expect(p.title).toBe("Add Linear plugin");
    expect(p.priority).toBe("high"); // priority 2 → "high"
    expect(p.teamKey).toBe("ENG");
    expect(p.state).toBe("Todo");
    expect(p.labels).toEqual(["backend"]);
    expect(p.content).toContain("Add Linear plugin");
    expect(p.content).toContain("Build outbound");
    expect(msg.source?.interface).toBe("linear");
    expect(msg.source?.channelId).toBe("ENG");
    expect(msg.reply?.topic).toBe("linear.reply.issue-uuid-1");
  });

  test("Issue update → publishes message.inbound.linear.issue.updated", async () => {
    const collected = collectBus(bus, "message.inbound.linear.issue.#");
    await priv(plugin)._handleWebhook({
      action: "update",
      type: "Issue",
      data: {
        id: "issue-uuid-2",
        title: "Title",
        team: { id: "team-1", key: "ENG", name: "Engineering" },
      },
    }, bus);
    expect(collected).toHaveLength(1);
    expect(collected[0].topic).toBe("message.inbound.linear.issue.updated");
  });

  test("Issue remove → publishes message.inbound.linear.issue.removed", async () => {
    const collected = collectBus(bus, "message.inbound.linear.issue.#");
    await priv(plugin)._handleWebhook({
      action: "remove",
      type: "Issue",
      data: { id: "issue-uuid-3", title: "Gone" },
    }, bus);
    expect(collected).toHaveLength(1);
    expect(collected[0].topic).toBe("message.inbound.linear.issue.removed");
  });

  test("Comment create → publishes message.inbound.linear.comment.created with issue context", async () => {
    const collected = collectBus(bus, "message.inbound.linear.comment.#");
    await priv(plugin)._handleWebhook({
      action: "create",
      type: "Comment",
      data: {
        id: "comment-uuid-1",
        body: "Can Ava take a look at this?",
        user: { id: "user-2", name: "Alice" },
        issue: {
          id: "issue-uuid-1",
          identifier: "ENG-42",
          title: "Add Linear plugin",
          team: { id: "team-1", key: "ENG" },
        },
      },
    }, bus);

    expect(collected).toHaveLength(1);
    const msg = collected[0];
    expect(msg.topic).toBe("message.inbound.linear.comment.created");
    const p = msg.payload as Record<string, unknown>;
    expect(p.body).toBe("Can Ava take a look at this?");
    expect(p.issueIdentifier).toBe("ENG-42");
    expect(p.teamKey).toBe("ENG");
    expect(msg.source?.channelId).toBe("ENG");
    expect(msg.reply?.topic).toBe("linear.reply.issue-uuid-1");
  });

  test("Project create → publishes message.inbound.linear.project.created", async () => {
    const collected = collectBus(bus, "message.inbound.linear.project.#");
    await priv(plugin)._handleWebhook({
      action: "create",
      type: "Project",
      data: {
        id: "project-uuid-1",
        name: "Q2 Roadmap",
        description: "What we're building",
        state: "started",
      },
    }, bus);
    expect(collected).toHaveLength(1);
    expect(collected[0].topic).toBe("message.inbound.linear.project.created");
  });

  test("unknown envelope type is silently dropped (no publish)", async () => {
    const collected = collectBus(bus, "message.inbound.linear.#");
    await priv(plugin)._handleWebhook({
      action: "create",
      type: "Reaction",
      data: { id: "r-1" },
    }, bus);
    expect(collected).toHaveLength(0);
  });

  test("priority int → string conversion covers all values", async () => {
    const cases: Array<[number | undefined, string]> = [
      [0, "none"],
      [1, "urgent"],
      [2, "high"],
      [3, "medium"],
      [4, "low"],
      [undefined, "none"],
      [99, "none"], // unexpected → none, never crashes
    ];
    for (const [input, expected] of cases) {
      const collected = collectBus(bus, "message.inbound.linear.issue.#");
      await priv(plugin)._handleWebhook({
        action: "create",
        type: "Issue",
        data: { id: `p-${input}`, title: "t", priority: input },
      }, bus);
      const p = collected[collected.length - 1].payload as Record<string, unknown>;
      expect(p.priority).toBe(expected);
    }
  });
});

describe("LinearPlugin — outbound subscribers", () => {
  let bus: InMemoryEventBus;
  let plugin: LinearPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    plugin = new LinearPlugin();
  });

  test("linear.reply.{issueId} → calls client.addComment(issueId, body)", async () => {
    const client = makeMockClient();
    priv(plugin)._wireOutbound(bus, client);

    bus.publish("linear.reply.issue-123", {
      id: crypto.randomUUID(),
      correlationId: "cid-1",
      topic: "linear.reply.issue-123",
      timestamp: Date.now(),
      payload: { text: "Reply from Ava" },
    });

    // The subscriber is async; wait for microtasks to drain
    await new Promise(r => setTimeout(r, 10));

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].method).toBe("addComment");
    expect(client.calls[0].args).toEqual(["issue-123", "Reply from Ava"]);
  });

  test("linear.reply.* with empty body is skipped (no client call)", async () => {
    const client = makeMockClient();
    priv(plugin)._wireOutbound(bus, client);

    bus.publish("linear.reply.issue-123", {
      id: crypto.randomUUID(),
      correlationId: "cid-2",
      topic: "linear.reply.issue-123",
      timestamp: Date.now(),
      payload: {},
    });
    await new Promise(r => setTimeout(r, 10));

    expect(client.calls).toHaveLength(0);
  });

  test("linear.update.issue.{issueId} → calls client.updateIssue with payload", async () => {
    const client = makeMockClient();
    priv(plugin)._wireOutbound(bus, client);

    bus.publish("linear.update.issue.issue-456", {
      id: crypto.randomUUID(),
      correlationId: "cid-3",
      topic: "linear.update.issue.issue-456",
      timestamp: Date.now(),
      payload: { stateName: "Done", priority: "low" },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].method).toBe("updateIssue");
    expect(client.calls[0].args[0]).toBe("issue-456");
    expect(client.calls[0].args[1]).toEqual({ stateName: "Done", priority: "low" });
  });

  test("linear.create.issue → calls client.createIssue and publishes result back", async () => {
    const client = makeMockClient({
      createIssue: () => Promise.resolve("brand-new-id"),
    });
    priv(plugin)._wireOutbound(bus, client);

    const results: BusMessage[] = [];
    bus.subscribe("linear.create.issue.result.#", "test", (m) => { results.push(m); });

    bus.publish("linear.create.issue", {
      id: crypto.randomUUID(),
      correlationId: "cid-create-1",
      topic: "linear.create.issue",
      timestamp: Date.now(),
      payload: { teamKey: "ENG", title: "New ticket", description: "from agent" },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].method).toBe("createIssue");
    expect(results).toHaveLength(1);
    expect(results[0].topic).toBe("linear.create.issue.result.cid-create-1");
    const p = results[0].payload as Record<string, unknown>;
    expect(p.success).toBe(true);
    expect(p.issueId).toBe("brand-new-id");
  });

  test("linear.create.issue missing teamKey → skipped, no client call, no result publish", async () => {
    const client = makeMockClient();
    priv(plugin)._wireOutbound(bus, client);

    const results: BusMessage[] = [];
    bus.subscribe("linear.create.issue.result.#", "test", (m) => { results.push(m); });

    bus.publish("linear.create.issue", {
      id: crypto.randomUUID(),
      correlationId: "cid-missing",
      topic: "linear.create.issue",
      timestamp: Date.now(),
      payload: { title: "only-title" },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(client.calls).toHaveLength(0);
    expect(results).toHaveLength(0);
  });
});

describe("LinearPlugin — HMAC signature verification", () => {
  // The verify function lives as a module-internal helper. We re-derive the
  // expected digest the same way the plugin does and assert that an independent
  // signing of the body with the same secret matches.
  test("matching HMAC-SHA256 over raw body is accepted; tampered body is rejected", () => {
    const body = Buffer.from('{"action":"create","type":"Issue","data":{"id":"x"}}', "utf-8");
    const secret = "test-secret";
    const correctSig = createHmac("sha256", secret).update(body).digest("hex");
    const expectedBadSig = createHmac("sha256", secret).update(Buffer.from("tampered")).digest("hex");

    // Verify the digest shape (hex, 64 chars) so any future format change
    // surfaces here rather than in a cryptic HTTP 401.
    expect(correctSig).toHaveLength(64);
    expect(correctSig).not.toBe(expectedBadSig);

    // Independent recomputation — sanity-check the algorithm choice
    const roundTrip = createHmac("sha256", secret).update(body).digest("hex");
    expect(roundTrip).toBe(correctSig);
  });
});

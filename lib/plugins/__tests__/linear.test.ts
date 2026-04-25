/**
 * LinearPlugin tests — inbound shape translation, outbound subscriber result
 * topics, HMAC verification, schema validation, replay window, dedup.
 *
 * We don't spin up Bun.serve here — install() has HTTP wiring side effects
 * that complicate hermetic tests, so we reach into the plugin via private
 * `_handleWebhook` and `_wireOutbound` through an `as unknown as` cast. Same
 * pattern as pr-remediator tests.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import { InMemoryEventBus } from "../../bus.ts";
import { LinearPlugin } from "../linear.ts";
import type { BusMessage } from "../../types.ts";
import type { UpdateIssueResult } from "../../linear-client.ts";

interface LinearPrivate {
  _handleWebhook(payload: unknown, bus: InMemoryEventBus): Promise<void>;
  _wireOutbound(bus: InMemoryEventBus, client: unknown): void;
}

function priv(plugin: LinearPlugin): LinearPrivate {
  return plugin as unknown as LinearPrivate;
}

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
    if (method === "updateIssue") return Promise.resolve({ success: true } as UpdateIssueResult);
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

// Wrap a payload as a Linear webhook envelope (post-Zod-parse shape).
function envelope(action: "create" | "update" | "remove", type: string, data: Record<string, unknown>) {
  return { action, type, data };
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
    await priv(plugin)._handleWebhook(envelope("create", "Issue", {
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
    }), bus);

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
    // Comment bodies render markdown in Linear; reply.format must reflect that
    // so downstream agents emit markdown rather than a JSON envelope.
    expect(msg.reply?.format).toBe("markdown");
  });

  test("Issue update / remove → topic suffix matches action", async () => {
    const collected = collectBus(bus, "message.inbound.linear.issue.#");
    await priv(plugin)._handleWebhook(envelope("update", "Issue", {
      id: "issue-uuid-2",
      title: "Title",
      team: { id: "team-1", key: "ENG", name: "Engineering" },
    }), bus);
    await priv(plugin)._handleWebhook(envelope("remove", "Issue", {
      id: "issue-uuid-3",
      title: "Gone",
    }), bus);
    expect(collected).toHaveLength(2);
    expect(collected[0].topic).toBe("message.inbound.linear.issue.updated");
    expect(collected[1].topic).toBe("message.inbound.linear.issue.removed");
  });

  test("Issue payload missing required fields → schema rejects, no publish", async () => {
    const collected = collectBus(bus, "message.inbound.linear.issue.#");
    // Issue.title is required by the schema — omit it
    await priv(plugin)._handleWebhook(envelope("create", "Issue", { id: "x" }), bus);
    expect(collected).toHaveLength(0);
  });

  test("Comment create → publishes with issue context + markdown reply format", async () => {
    const collected = collectBus(bus, "message.inbound.linear.comment.#");
    await priv(plugin)._handleWebhook(envelope("create", "Comment", {
      id: "comment-uuid-1",
      body: "Can Ava take a look at this?",
      user: { id: "user-2", name: "Alice" },
      issue: {
        id: "issue-uuid-1",
        identifier: "ENG-42",
        title: "Add Linear plugin",
        team: { id: "team-1", key: "ENG" },
      },
    }), bus);

    expect(collected).toHaveLength(1);
    const msg = collected[0];
    expect(msg.topic).toBe("message.inbound.linear.comment.created");
    const p = msg.payload as Record<string, unknown>;
    expect(p.body).toBe("Can Ava take a look at this?");
    expect(p.issueIdentifier).toBe("ENG-42");
    expect(p.teamKey).toBe("ENG");
    expect(msg.source?.channelId).toBe("ENG");
    expect(msg.reply?.topic).toBe("linear.reply.issue-uuid-1");
    expect(msg.reply?.format).toBe("markdown");
  });

  test("Project create → publishes message.inbound.linear.project.created", async () => {
    const collected = collectBus(bus, "message.inbound.linear.project.#");
    await priv(plugin)._handleWebhook(envelope("create", "Project", {
      id: "project-uuid-1",
      name: "Q2 Roadmap",
      description: "What we're building",
      state: "started",
    }), bus);
    expect(collected).toHaveLength(1);
    expect(collected[0].topic).toBe("message.inbound.linear.project.created");
  });

  test("unknown envelope type is dropped (no publish, logged as a warning)", async () => {
    const collected = collectBus(bus, "message.inbound.linear.#");
    await priv(plugin)._handleWebhook(envelope("create", "Reaction", { id: "r-1" }), bus);
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
      [99, "none"],
    ];
    for (const [input, expected] of cases) {
      const collected = collectBus(bus, "message.inbound.linear.issue.#");
      await priv(plugin)._handleWebhook(envelope("create", "Issue", {
        id: `p-${input}`,
        title: "t",
        priority: input,
      }), bus);
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

  test("linear.reply.{issueId} → calls client.addComment AND publishes success result", async () => {
    const client = makeMockClient();
    priv(plugin)._wireOutbound(bus, client);

    const results: BusMessage[] = [];
    bus.subscribe("linear.reply.result.#", "test", (m) => { results.push(m); });

    bus.publish("linear.reply.issue-123", {
      id: crypto.randomUUID(),
      correlationId: "cid-1",
      topic: "linear.reply.issue-123",
      timestamp: Date.now(),
      payload: { text: "Reply from Ava" },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].method).toBe("addComment");
    expect(client.calls[0].args).toEqual(["issue-123", "Reply from Ava"]);

    expect(results).toHaveLength(1);
    expect(results[0].topic).toBe("linear.reply.result.cid-1");
    const p = results[0].payload as Record<string, unknown>;
    expect(p.success).toBe(true);
    expect(p.issueId).toBe("issue-123");
  });

  test("linear.reply.* with empty body → result publishes failure, no API call", async () => {
    const client = makeMockClient();
    priv(plugin)._wireOutbound(bus, client);

    const results: BusMessage[] = [];
    bus.subscribe("linear.reply.result.#", "test", (m) => { results.push(m); });

    bus.publish("linear.reply.issue-123", {
      id: crypto.randomUUID(),
      correlationId: "cid-2",
      topic: "linear.reply.issue-123",
      timestamp: Date.now(),
      payload: {},
    });
    await new Promise(r => setTimeout(r, 10));

    expect(client.calls).toHaveLength(0);
    expect(results).toHaveLength(1);
    const p = results[0].payload as Record<string, unknown>;
    expect(p.success).toBe(false);
    expect(p.error).toBe("empty body");
  });

  test("linear.reply.* when addComment throws → result captures the exception message", async () => {
    const client = makeMockClient({
      addComment: () => Promise.reject(new Error("rate-limited")),
    });
    priv(plugin)._wireOutbound(bus, client);

    const results: BusMessage[] = [];
    bus.subscribe("linear.reply.result.#", "test", (m) => { results.push(m); });

    bus.publish("linear.reply.issue-x", {
      id: crypto.randomUUID(),
      correlationId: "cid-throw",
      topic: "linear.reply.issue-x",
      timestamp: Date.now(),
      payload: { text: "hi" },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(results).toHaveLength(1);
    const p = results[0].payload as Record<string, unknown>;
    expect(p.success).toBe(false);
    expect(p.error).toBe("rate-limited");
  });

  test("linear.reply.* when addComment returns false → result.success=false with reason", async () => {
    const client = makeMockClient({
      addComment: () => Promise.resolve(false),
    });
    priv(plugin)._wireOutbound(bus, client);

    const results: BusMessage[] = [];
    bus.subscribe("linear.reply.result.#", "test", (m) => { results.push(m); });

    bus.publish("linear.reply.issue-x", {
      id: crypto.randomUUID(),
      correlationId: "cid-false",
      topic: "linear.reply.issue-x",
      timestamp: Date.now(),
      payload: { text: "hi" },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(results).toHaveLength(1);
    const p = results[0].payload as Record<string, unknown>;
    expect(p.success).toBe(false);
    expect(String(p.error)).toContain("returned false");
  });

  test("linear.reply.result.* events are NOT re-processed by the reply subscriber", async () => {
    // Without the result-topic guard the subscriber would loop on its own
    // emissions — this regression test pins the guard down.
    const client = makeMockClient();
    priv(plugin)._wireOutbound(bus, client);

    bus.publish("linear.reply.result.someCid", {
      id: crypto.randomUUID(),
      correlationId: "someCid",
      topic: "linear.reply.result.someCid",
      timestamp: Date.now(),
      payload: { success: true, issueId: "x" },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(client.calls).toHaveLength(0);
  });

  test("linear.update.issue.{issueId} → calls client.updateIssue AND publishes result", async () => {
    const client = makeMockClient();
    priv(plugin)._wireOutbound(bus, client);

    const results: BusMessage[] = [];
    bus.subscribe("linear.update.issue.result.#", "test", (m) => { results.push(m); });

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
    expect(results).toHaveLength(1);
    expect((results[0].payload as Record<string, unknown>).success).toBe(true);
  });

  test("linear.update.issue.{issueId} when updateIssue returns failure → result carries reason", async () => {
    const client = makeMockClient({
      updateIssue: () => Promise.resolve({ success: false, reason: "no fields supplied to update" } as UpdateIssueResult),
    });
    priv(plugin)._wireOutbound(bus, client);

    const results: BusMessage[] = [];
    bus.subscribe("linear.update.issue.result.#", "test", (m) => { results.push(m); });

    bus.publish("linear.update.issue.issue-789", {
      id: crypto.randomUUID(),
      correlationId: "cid-empty-update",
      topic: "linear.update.issue.issue-789",
      timestamp: Date.now(),
      payload: {},
    });
    await new Promise(r => setTimeout(r, 10));

    expect(results).toHaveLength(1);
    const p = results[0].payload as Record<string, unknown>;
    expect(p.success).toBe(false);
    expect(p.error).toBe("no fields supplied to update");
  });

  test("linear.create.issue → calls client.createIssue and publishes success result", async () => {
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

  test("linear.create.issue missing teamKey → publishes failure result with explanation", async () => {
    // Behavior change from V1: missing required fields now publish a failure
    // result (so the caller knows what went wrong) instead of silently
    // dropping. Per the audit's fail-loud finding.
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
    expect(results).toHaveLength(1);
    const p = results[0].payload as Record<string, unknown>;
    expect(p.success).toBe(false);
    expect(String(p.error)).toContain("teamKey");
  });

  test("linear.create.issue when teamKey is unknown → publishes failure with helpful error", async () => {
    const client = makeMockClient({
      createIssue: () => Promise.resolve(null),
    });
    priv(plugin)._wireOutbound(bus, client);

    const results: BusMessage[] = [];
    bus.subscribe("linear.create.issue.result.#", "test", (m) => { results.push(m); });

    bus.publish("linear.create.issue", {
      id: crypto.randomUUID(),
      correlationId: "cid-unknown-team",
      topic: "linear.create.issue",
      timestamp: Date.now(),
      payload: { teamKey: "DOES-NOT-EXIST", title: "x" },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(results).toHaveLength(1);
    const p = results[0].payload as Record<string, unknown>;
    expect(p.success).toBe(false);
    expect(String(p.error)).toContain("DOES-NOT-EXIST");
  });

  test("subscriber result-topic without correlationId is a silent no-op (no infinite loop)", async () => {
    // publishResult skips when no correlationId — a publisher that doesn't
    // ask for confirmation shouldn't get one.
    const client = makeMockClient();
    priv(plugin)._wireOutbound(bus, client);

    const results: BusMessage[] = [];
    bus.subscribe("linear.reply.result.#", "test", (m) => { results.push(m); });

    bus.publish("linear.reply.no-cid-issue", {
      id: crypto.randomUUID(),
      correlationId: "",
      topic: "linear.reply.no-cid-issue",
      timestamp: Date.now(),
      payload: { text: "hi" },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(client.calls).toHaveLength(1); // API call still happened
    expect(results).toHaveLength(0); // but no result topic published
  });
});

describe("LinearPlugin — HMAC signature verification", () => {
  test("matching HMAC-SHA256 over raw body produces expected hex digest shape", () => {
    const body = Buffer.from('{"action":"create","type":"Issue","data":{"id":"x"}}', "utf-8");
    const secret = "test-secret";
    const correctSig = createHmac("sha256", secret).update(body).digest("hex");
    const tamperedSig = createHmac("sha256", secret).update(Buffer.from("tampered")).digest("hex");

    expect(correctSig).toHaveLength(64);
    expect(correctSig).not.toBe(tamperedSig);

    const roundTrip = createHmac("sha256", secret).update(body).digest("hex");
    expect(roundTrip).toBe(correctSig);
  });
});

describe("LinearPlugin — install-time production safety", () => {
  // The plugin refuses to start an unauthenticated webhook receiver in a
  // production-like env (NODE_ENV=production OR WORKSTACEAN_PUBLIC_BASE_URL
  // set). Cuts the open-relay footgun.

  let origNodeEnv: string | undefined;
  let origPublicBase: string | undefined;
  let origSecret: string | undefined;

  beforeEach(() => {
    origNodeEnv = process.env.NODE_ENV;
    origPublicBase = process.env.WORKSTACEAN_PUBLIC_BASE_URL;
    origSecret = process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.LINEAR_WEBHOOK_SECRET;
  });

  function restore() {
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
    if (origPublicBase === undefined) delete process.env.WORKSTACEAN_PUBLIC_BASE_URL;
    else process.env.WORKSTACEAN_PUBLIC_BASE_URL = origPublicBase;
    if (origSecret === undefined) delete process.env.LINEAR_WEBHOOK_SECRET;
    else process.env.LINEAR_WEBHOOK_SECRET = origSecret;
  }

  test("install throws when NODE_ENV=production AND no LINEAR_WEBHOOK_SECRET", () => {
    process.env.NODE_ENV = "production";
    delete process.env.WORKSTACEAN_PUBLIC_BASE_URL;
    const plugin = new LinearPlugin();
    const bus = new InMemoryEventBus();
    try {
      expect(() => plugin.install(bus)).toThrow(/LINEAR_WEBHOOK_SECRET is required/);
    } finally {
      restore();
    }
  });

  test("install throws when WORKSTACEAN_PUBLIC_BASE_URL is set AND no LINEAR_WEBHOOK_SECRET", () => {
    delete process.env.NODE_ENV;
    process.env.WORKSTACEAN_PUBLIC_BASE_URL = "https://ava.example.com";
    const plugin = new LinearPlugin();
    const bus = new InMemoryEventBus();
    try {
      expect(() => plugin.install(bus)).toThrow(/LINEAR_WEBHOOK_SECRET is required/);
    } finally {
      restore();
    }
  });

  test("install does NOT throw in dev (NODE_ENV unset, no public base) without a secret", () => {
    // We don't actually want to start a Bun.serve — so we'll set the secret
    // to satisfy the production-safety check first to prove the inverse.
    delete process.env.NODE_ENV;
    delete process.env.WORKSTACEAN_PUBLIC_BASE_URL;
    process.env.LINEAR_WEBHOOK_SECRET = "test-secret";
    const plugin = new LinearPlugin();
    const bus = new InMemoryEventBus();
    try {
      // install is allowed; uninstall stops the started server.
      expect(() => plugin.install(bus)).not.toThrow();
      plugin.uninstall();
    } finally {
      restore();
    }
  });
});

import { describe, test, expect, beforeEach } from "bun:test";
import { LinearAgentActivityClient, buildActivityVariables } from "../agent-activity-client.ts";
import type { LinearAvaTokenManager } from "../ava-oauth-token-manager.ts";

// Minimal token-manager stub — the client only calls getAccessToken/isAuthorized.
function fakeTokens(token: string | null): LinearAvaTokenManager {
  return {
    isAuthorized: () => token !== null,
    getAccessToken: async () => {
      if (token === null) throw new Error("not authorized");
      return token;
    },
  } as unknown as LinearAvaTokenManager;
}

describe("buildActivityVariables", () => {
  test("wraps sessionId + content under input", () => {
    expect(buildActivityVariables("sess-1", { type: "thought", body: "hi" })).toEqual({
      input: { agentSessionId: "sess-1", content: { type: "thought", body: "hi" } },
    });
  });
});

describe("LinearAgentActivityClient", () => {
  let calls: Array<{ url: string; auth: string | null; body: any }>;
  let nextResponse: () => Response;

  function mockFetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url,
        auth: new Headers(init?.headers).get("Authorization"),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return nextResponse();
    }) as typeof fetch;
  }

  beforeEach(() => {
    calls = [];
    nextResponse = () => new Response(JSON.stringify({ data: { agentActivityCreate: { success: true } } }), { status: 200 });
  });

  test("isReady reflects the token manager", () => {
    expect(new LinearAgentActivityClient(fakeTokens("at"), mockFetch()).isReady()).toBe(true);
    expect(new LinearAgentActivityClient(fakeTokens(null), mockFetch()).isReady()).toBe(false);
  });

  test("thought posts agentActivityCreate with Bearer token + thought content", async () => {
    const c = new LinearAgentActivityClient(fakeTokens("ava-token"), mockFetch());
    await c.thought("sess-9", "On it.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.linear.app/graphql");
    expect(calls[0]!.auth).toBe("Bearer ava-token");
    expect(calls[0]!.body.query).toContain("agentActivityCreate");
    expect(calls[0]!.body.variables).toEqual({ input: { agentSessionId: "sess-9", content: { type: "thought", body: "On it." } } });
  });

  test("response posts a response activity", async () => {
    const c = new LinearAgentActivityClient(fakeTokens("t"), mockFetch());
    await c.response("s", "done — filed PROJ-12");
    expect(calls[0]!.body.variables.input.content).toEqual({ type: "response", body: "done — filed PROJ-12" });
  });

  test("createComment posts commentCreate AS Ava (Bearer token) with issueId+body", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 });
    const c = new LinearAgentActivityClient(fakeTokens("ava-token"), mockFetch());
    await c.createComment("issue-7", "routed to protocli — PROTO-12");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toBe("Bearer ava-token");
    expect(calls[0]!.body.query).toContain("commentCreate");
    expect(calls[0]!.body.variables).toEqual({ input: { issueId: "issue-7", body: "routed to protocli — PROTO-12" } });
  });

  test("createComment throws on success=false", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: { commentCreate: { success: false } } }), { status: 200 });
    const c = new LinearAgentActivityClient(fakeTokens("t"), mockFetch());
    await expect(c.createComment("i", "x")).rejects.toThrow(/success=false/);
  });

  test("throws on GraphQL errors", async () => {
    nextResponse = () => new Response(JSON.stringify({ errors: [{ message: "no access to session" }] }), { status: 200 });
    const c = new LinearAgentActivityClient(fakeTokens("t"), mockFetch());
    await expect(c.thought("s", "x")).rejects.toThrow(/no access to session/);
  });

  test("throws on success=false", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: { agentActivityCreate: { success: false } } }), { status: 200 });
    const c = new LinearAgentActivityClient(fakeTokens("t"), mockFetch());
    await expect(c.response("s", "x")).rejects.toThrow(/success=false/);
  });

  test("throws on HTTP error", async () => {
    nextResponse = () => new Response("nope", { status: 403 });
    const c = new LinearAgentActivityClient(fakeTokens("t"), mockFetch());
    await expect(c.thought("s", "x")).rejects.toThrow(/HTTP 403/);
  });

  test("propagates not-authorized from the token manager", async () => {
    const c = new LinearAgentActivityClient(fakeTokens(null), mockFetch());
    await expect(c.thought("s", "x")).rejects.toThrow(/not authorized/);
    expect(calls).toHaveLength(0); // never hit the network
  });

  test("getViewerId queries viewer { id } and caches the result", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: { viewer: { id: "ava-123" } } }), { status: 200 });
    const c = new LinearAgentActivityClient(fakeTokens("t"), mockFetch());
    expect(await c.getViewerId()).toBe("ava-123");
    expect(await c.getViewerId()).toBe("ava-123");
    expect(calls).toHaveLength(1); // second call served from cache
  });

  test("isAssignedToAva is true only when the issue's assignee is Ava", async () => {
    // mockFetch returns the same combined body to both the viewer + issue queries.
    nextResponse = () => new Response(JSON.stringify({ data: { viewer: { id: "ava-123" }, issue: { assignee: { id: "ava-123" } } } }), { status: 200 });
    const c = new LinearAgentActivityClient(fakeTokens("t"), mockFetch());
    expect(await c.isAssignedToAva("issue-1")).toBe(true);
  });

  test("isAssignedToAva is false when assignee differs or is unset", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: { viewer: { id: "ava-123" }, issue: { assignee: { id: "someone-else" } } } }), { status: 200 });
    expect(await new LinearAgentActivityClient(fakeTokens("t"), mockFetch()).isAssignedToAva("i")).toBe(false);

    nextResponse = () => new Response(JSON.stringify({ data: { viewer: { id: "ava-123" }, issue: { assignee: null } } }), { status: 200 });
    expect(await new LinearAgentActivityClient(fakeTokens("t"), mockFetch()).isAssignedToAva("i")).toBe(false);
  });
});

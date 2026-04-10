import { describe, it, expect, afterEach } from "bun:test";
import { GraphitiClient } from "../graphiti-client.ts";

// ── fetch mock helpers ─────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(body: unknown, status = 200) {
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
}

function mockFetchThrow(error: Error) {
  globalThis.fetch = (async () => { throw error; }) as unknown as typeof fetch;
}

let lastFetchUrl = "";
let lastFetchBody: unknown;

function spyFetch(body: unknown, status = 200) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    lastFetchUrl = url.toString();
    lastFetchBody = init?.body ? JSON.parse(init.body as string) : undefined;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  lastFetchUrl = "";
  lastFetchBody = undefined;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GraphitiClient.getContextBlock", () => {
  it("returns empty string when no facts returned", async () => {
    mockFetch({ facts: [] });
    const client = new GraphitiClient();
    const result = await client.getContextBlock("user:josh", "hello");
    expect(result).toBe("");
  });

  it("returns formatted block for active facts", async () => {
    mockFetch({
      facts: [
        { uuid: "1", name: "pref", fact: "Prefers concise answers", valid_at: null, invalid_at: null, created_at: "2026-01-01", expired_at: null },
        { uuid: "2", name: "proj", fact: "Works on protoWorkstacean", valid_at: null, invalid_at: null, created_at: "2026-01-01", expired_at: null },
      ],
    });
    const client = new GraphitiClient();
    const result = await client.getContextBlock("user:josh", "hello");
    expect(result).toContain("[User context — user:josh]");
    expect(result).toContain("- Prefers concise answers");
    expect(result).toContain("- Works on protoWorkstacean");
    expect(result).toMatch(/\n$/);
  });

  it("filters out facts with invalid_at in the past", async () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    mockFetch({
      facts: [
        { uuid: "1", name: "old", fact: "Lives in Berlin", valid_at: null, invalid_at: pastDate, created_at: "2026-01-01", expired_at: null },
        { uuid: "2", name: "current", fact: "Lives in London", valid_at: null, invalid_at: null, created_at: "2026-01-01", expired_at: null },
      ],
    });
    const client = new GraphitiClient();
    const result = await client.getContextBlock("user:josh", "hello");
    expect(result).not.toContain("Lives in Berlin");
    expect(result).toContain("Lives in London");
  });

  it("filters out facts with expired_at in the past", async () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    mockFetch({
      facts: [
        { uuid: "1", name: "expired", fact: "Temporary preference", valid_at: null, invalid_at: null, created_at: "2026-01-01", expired_at: pastDate },
      ],
    });
    const client = new GraphitiClient();
    const result = await client.getContextBlock("user:josh", "hello");
    expect(result).toBe("");
  });

  it("includes facts with future invalid_at", async () => {
    const futureDate = new Date(Date.now() + 86400_000).toISOString();
    mockFetch({
      facts: [
        { uuid: "1", name: "valid", fact: "Still valid fact", valid_at: null, invalid_at: futureDate, created_at: "2026-01-01", expired_at: null },
      ],
    });
    const client = new GraphitiClient();
    const result = await client.getContextBlock("user:josh", "hello");
    expect(result).toContain("Still valid fact");
  });

  it("returns empty string when fetch throws", async () => {
    mockFetchThrow(new Error("network error"));
    const client = new GraphitiClient();
    // The caller wraps with .catch(() => ""), but the client itself should throw.
    // Test that the error propagates (caller decides how to handle it).
    await expect(client.getContextBlock("user:josh", "hello")).rejects.toThrow("network error");
  });

  it("sends correct request body to /get-memory", async () => {
    spyFetch({ facts: [] });
    const client = new GraphitiClient();
    await client.getContextBlock("user:josh", "what is my name?");
    expect(lastFetchUrl).toContain("/get-memory");
    expect(lastFetchBody).toMatchObject({
      group_id: "user:josh",
      messages: [{ content: "what is my name?", role_type: "user" }],
      max_facts: 15,
    });
  });
});

describe("GraphitiClient.addEpisode", () => {
  it("posts to /messages with correct user and assistant turns", async () => {
    spyFetch(null, 202);
    const client = new GraphitiClient();
    await client.addEpisode({
      groupId: "user:josh",
      userMessage: "Hello agent",
      agentMessage: "Hello Josh!",
      userRole: "Josh",
      agentName: "ava",
      platform: "discord",
      channelId: "12345",
    });

    expect(lastFetchUrl).toContain("/messages");
    const body = lastFetchBody as { group_id: string; messages: Array<{ role_type: string; content: string; role?: string }> };
    expect(body.group_id).toBe("user:josh");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]!.role_type).toBe("user");
    expect(body.messages[0]!.content).toBe("Hello agent");
    expect(body.messages[0]!.role).toBe("Josh");
    expect(body.messages[1]!.role_type).toBe("assistant");
    expect(body.messages[1]!.content).toBe("Hello Josh!");
    expect(body.messages[1]!.role).toBe("ava");
  });

  it("uses groupId as role when no userRole provided", async () => {
    spyFetch(null, 202);
    const client = new GraphitiClient();
    await client.addEpisode({
      groupId: "user:discord_999",
      userMessage: "hi",
      agentMessage: "hello",
    });
    const body = lastFetchBody as { messages: Array<{ role: string }> };
    expect(body.messages[0]!.role).toBe("user:discord_999");
  });

  it("throws on non-2xx response", async () => {
    mockFetch({ error: "bad request" }, 400);
    const client = new GraphitiClient();
    await expect(
      client.addEpisode({ groupId: "user:josh", userMessage: "x", agentMessage: "y" })
    ).rejects.toThrow("400");
  });
});

describe("GraphitiClient.search", () => {
  it("returns facts array from /search", async () => {
    mockFetch({
      facts: [
        { uuid: "1", name: "pref", fact: "Likes TypeScript", valid_at: null, invalid_at: null, created_at: "2026-01-01", expired_at: null },
      ],
    });
    const client = new GraphitiClient();
    const facts = await client.search("user:josh", "typescript preferences", 5);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.fact).toBe("Likes TypeScript");
  });

  it("returns empty array when no facts", async () => {
    mockFetch({ facts: [] });
    const client = new GraphitiClient();
    const facts = await client.search("user:josh", "anything");
    expect(facts).toEqual([]);
  });

  it("sends correct body to /search", async () => {
    spyFetch({ facts: [] });
    const client = new GraphitiClient();
    await client.search("user:josh", "my query", 7);
    expect(lastFetchUrl).toContain("/search");
    expect(lastFetchBody).toMatchObject({
      query: "my query",
      group_ids: ["user:josh"],
      max_facts: 7,
    });
  });
});

describe("GraphitiClient.clearUser", () => {
  it("calls DELETE /group/{groupId}", async () => {
    spyFetch(null, 200);
    const client = new GraphitiClient();
    await client.clearUser("user:josh");
    expect(lastFetchUrl).toContain("/group/user%3Ajosh");
  });

  it("throws on non-2xx response", async () => {
    mockFetch({ error: "not found" }, 404);
    const client = new GraphitiClient();
    await expect(client.clearUser("user:josh")).rejects.toThrow("404");
  });
});

describe("GraphitiClient.isHealthy", () => {
  it("returns true when healthcheck returns 200", async () => {
    mockFetch({ status: "ok" }, 200);
    const client = new GraphitiClient();
    expect(await client.isHealthy()).toBe(true);
  });

  it("returns false when healthcheck returns 503", async () => {
    mockFetch({ error: "unavailable" }, 503);
    const client = new GraphitiClient();
    expect(await client.isHealthy()).toBe(false);
  });

  it("returns false when fetch throws (unreachable)", async () => {
    mockFetchThrow(new Error("ECONNREFUSED"));
    const client = new GraphitiClient();
    expect(await client.isHealthy()).toBe(false);
  });
});

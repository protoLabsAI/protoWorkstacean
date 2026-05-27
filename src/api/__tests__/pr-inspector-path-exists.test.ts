/**
 * pr-inspector `path_exists` action (#3900) — lets Quinn verify that a path a
 * diff depends on (a COPY-from source, a filtered workspace package) actually
 * exists in the referenced repo before assigning a severity. Cross-repo by
 * design: the `repo` arg may differ from the PR under review.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRoutes, setGithubAuthForTesting } from "../pr-inspector.ts";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import type { ApiContext } from "../types.ts";

let lastUrl: string;
let nextStatus: number;
let origFetch: typeof globalThis.fetch;

function ctx(): ApiContext {
  return { bus: new InMemoryEventBus(), executorRegistry: {} as never } as unknown as ApiContext;
}

function handler() {
  const route = createRoutes(ctx()).find((r) => r.path === "/api/pr/inspect" && r.method === "POST");
  if (!route) throw new Error("route not found");
  return route.handler;
}

function inspect(body: Record<string, unknown>): Request {
  return new Request("http://local/api/pr/inspect", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  setGithubAuthForTesting(async () => "test-token");
  lastUrl = "";
  nextStatus = 200;
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    lastUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new Response(nextStatus === 200 ? JSON.stringify({ name: "x" }) : "Not Found", { status: nextStatus });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  setGithubAuthForTesting(undefined);
});

describe("pr-inspector path_exists (#3900)", () => {
  test("200 → EXISTS, hits the contents API for the given repo + path + ref", async () => {
    nextStatus = 200;
    const res = await handler()(inspect({
      action: "path_exists", repo: "protoLabsAI/rabbit-hole.io", path: "packages/cli", ref: "main",
    }), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { result: string } };
    expect(json.success).toBe(true);
    expect(json.data.result).toContain("EXISTS");
    expect(lastUrl).toBe("https://api.github.com/repos/protoLabsAI/rabbit-hole.io/contents/packages/cli?ref=main");
  });

  test("404 → MISSING, flagged as a real blocker", async () => {
    nextStatus = 404;
    const res = await handler()(inspect({
      action: "path_exists", repo: "protoLabsAI/rabbit-hole.io", path: "packages/cli",
    }), {});
    expect(res.status).toBe(200); // the action succeeded; the path just isn't there
    const json = (await res.json()) as { success: boolean; data: { result: string } };
    expect(json.data.result).toContain("MISSING");
    expect(json.data.result).toContain("real blocker");
    expect(lastUrl).toBe("https://api.github.com/repos/protoLabsAI/rabbit-hole.io/contents/packages/cli");
  });

  test("strips a leading slash from the path (contents API is repo-relative)", async () => {
    nextStatus = 200;
    await handler()(inspect({
      action: "path_exists", repo: "o/r", path: "/src/packages/cli/dist",
    }), {});
    expect(lastUrl).toBe("https://api.github.com/repos/o/r/contents/src/packages/cli/dist");
  });

  test("missing path arg → 400", async () => {
    const res = await handler()(inspect({ action: "path_exists", repo: "o/r" }), {});
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.error).toContain("path is required");
  });
});

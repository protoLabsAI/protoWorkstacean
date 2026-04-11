import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createBusTools } from "./bus-tools.js";

type AnyTool = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any, extra: unknown) => Promise<any>;
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

function callTool(tool: AnyTool, args: Record<string, unknown>): Promise<ToolResult> {
  return tool.handler(args, undefined) as Promise<ToolResult>;
}

describe("bus-tools error shape", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("fetch failed")),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("publish_event returns BusToolError on network failure", async () => {
    const tools = createBusTools({ baseUrl: "http://localhost:9999" });
    const result = await callTool(tools[0] as AnyTool, {
      topic: "test.topic",
      payload: { foo: "bar" },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty("error");
    expect(parsed.error).toHaveProperty("code", "PUBLISH_EVENT_FAILED");
    expect(typeof parsed.error.message).toBe("string");
    expect(parsed.error.message).toBe("fetch failed");
  });

  test("get_world_state returns BusToolError on network failure", async () => {
    const tools = createBusTools({ baseUrl: "http://localhost:9999" });
    const result = await callTool(tools[1] as AnyTool, {});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("GET_WORLD_STATE_FAILED");
    expect(typeof parsed.error.message).toBe("string");
  });

  test("run_ceremony returns BusToolError on HTTP 404 error", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ) as unknown as typeof fetch;

    const tools = createBusTools({ baseUrl: "http://localhost:9999" });
    const result = await callTool(tools[10] as AnyTool, { ceremonyId: "no.such.ceremony" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("RUN_CEREMONY_FAILED");
    expect(parsed.error.message).toContain("404");
  });

  test("BusToolError has required code and message fields, no spurious details", async () => {
    const tools = createBusTools({ baseUrl: "http://localhost:9999" });
    const result = await callTool(tools[2] as AnyTool, {});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(typeof parsed.error.code).toBe("string");
    expect(typeof parsed.error.message).toBe("string");
    // details is optional — must not be present when not explicitly set
    expect(Object.keys(parsed.error)).not.toContain("details");
  });
});

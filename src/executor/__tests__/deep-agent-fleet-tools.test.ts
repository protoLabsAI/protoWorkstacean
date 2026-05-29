import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createLangChainTools } from "../executors/deep-agent-executor.ts";
import type { HttpClient } from "../../services/http-client.ts";
import type { StructuredToolInterface } from "@langchain/core/tools";

function fakeHttp(handlers: {
  get?: (url: string) => unknown;
  post?: (url: string, body: unknown) => unknown;
}): HttpClient {
  return {
    get: async (url: string) => handlers.get?.(url),
    post: async (url: string, body: unknown) => handlers.post?.(url, body),
  } as unknown as HttpClient;
}

function byName(tools: StructuredToolInterface[], name: string): StructuredToolInterface {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not built`);
  return t;
}

describe("deep-agent fleet tools", () => {
  beforeAll(() => { process.env.DEEP_AGENT_CHAT_POLL_INTERVAL_MS = "5"; });
  afterAll(() => { delete process.env.DEEP_AGENT_CHAT_POLL_INTERVAL_MS; });

  test("list_agents returns the live fleet, excluding self and the function cluster", async () => {
    const http = fakeHttp({
      get: (url) => {
        expect(url).toBe("/api/agents/runtime");
        return {
          success: true,
          data: {
            agents: [
              { name: "ava", type: "deep-agent", skills: ["chat"] },
              { name: "function", type: "function", skills: ["alert.fire", "ceremony.run"] },
              { name: "protopen", type: "a2a", skills: ["threat_intel", "passive_recon"] },
              { name: "quinn", type: "deep-agent", skills: ["pr_review"] },
            ],
          },
        };
      },
    });
    const tools = createLangChainTools(["list_agents"], http, undefined, "ava");
    const out = JSON.parse(await byName(tools, "list_agents").invoke({}) as string) as {
      agents: Array<{ name: string }>;
    };
    const names = out.agents.map((a) => a.name);

    expect(names).toContain("protopen");
    expect(names).toContain("quinn");
    expect(names).not.toContain("ava"); // self excluded
    expect(names).not.toContain("function"); // plugin infra excluded
  });

  test("chat_with_agent auto-polls a pending A2A task and returns the real output", async () => {
    let polls = 0;
    const http = fakeHttp({
      post: (url) => {
        expect(url).toBe("/api/a2a/chat");
        return {
          success: true,
          data: { pending: true, response: null, taskState: "working", correlationId: "c1", pollUrl: "/api/a2a/task/c1" },
        };
      },
      get: (url) => {
        expect(url).toBe("/api/a2a/task/c1");
        polls += 1;
        return polls < 2
          ? { success: true, data: { pending: true, taskState: "working", correlationId: "c1" } }
          : {
              success: true,
              data: { done: true, response: "ProtoPen is online and ready.", taskState: "completed", correlationId: "c1", taskId: "t9", contextId: "ctx" },
            };
      },
    });
    const tools = createLangChainTools(["chat_with_agent"], http, undefined, "ava");
    const out = JSON.parse(
      await byName(tools, "chat_with_agent").invoke({ agent: "protopen", message: "ping", skill: "threat_intel" }) as string,
    ) as { success: boolean; data: Record<string, unknown> };

    expect(out.success).toBe(true);
    expect(out.data.response).toBe("ProtoPen is online and ready.");
    expect(out.data.taskState).toBe("completed");
    expect(out.data.taskId).toBe("t9");
    expect(polls).toBe(2);
  });

  test("chat_with_agent returns inline results unchanged (no polling)", async () => {
    const http = fakeHttp({
      post: () => ({ success: true, data: { response: "fast answer", taskState: "completed", correlationId: "c2" } }),
      get: () => { throw new Error("should not poll an inline result"); },
    });
    const tools = createLangChainTools(["chat_with_agent"], http, undefined, "ava");
    const out = JSON.parse(
      await byName(tools, "chat_with_agent").invoke({ agent: "quinn", message: "hi" }) as string,
    ) as { data: Record<string, unknown> };
    expect(out.data.response).toBe("fast answer");
  });
});

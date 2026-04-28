/**
 * A2ADeliveryPlugin tests — verify channel gating, target lookup,
 * auth header forwarding, and the shape of the dispatched JSON-RPC
 * `message/send` request. The plugin only does HTTP fetch + bus
 * subscription; we inject a fetch mock to assert the outbound shape
 * without standing up an HTTP server.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryEventBus } from "../../bus.ts";
import { A2ADeliveryPlugin } from "../a2a-delivery.ts";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetchMock(status = 200): {
  fn: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const initHeaders = init?.headers as Record<string, string> | undefined;
    if (initHeaders) for (const k of Object.keys(initHeaders)) headers[k] = initHeaders[k];
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, headers, body });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: {} }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fn, calls };
}

function fireCron(
  bus: InMemoryEventBus,
  topic: string,
  payload: Record<string, unknown>,
): void {
  bus.publish(topic, {
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    topic,
    timestamp: Date.now(),
    payload,
  });
}

// Bus dispatch is synchronous-publish + async-handler — the plugin's
// handler awaits a fetch, so tests need a microtask flush.
async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 5));
}

describe("A2ADeliveryPlugin", () => {
  let workspaceDir: string;
  let bus: InMemoryEventBus;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "a2a-delivery-test-"));
    bus = new InMemoryEventBus();
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("delivers JSON-RPC message/send when channel=a2a and target is configured", async () => {
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  gina-personal:
    url: http://gina-personal:7870/a2a
    bearer_token: secret-bearer
`);
    const { fn, calls } = makeFetchMock();
    const plugin = new A2ADeliveryPlugin(workspaceDir, { fetch: fn });
    plugin.install(bus);

    fireCron(bus, "cron.gina-personal.daily", {
      content: "morning standup",
      channel: "a2a",
      agent_name: "gina-personal",
      scheduler_job_id: "gina-personal-daily",
    });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://gina-personal:7870/a2a");
    expect(calls[0].headers["Authorization"]).toBe("Bearer secret-bearer");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");

    const body = calls[0].body as {
      jsonrpc: string;
      method: string;
      params: { message: { role: string; parts: Array<{ kind: string; text: string }>; metadata: Record<string, unknown> } };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("message/send");
    expect(body.params.message.role).toBe("user");
    expect(body.params.message.parts[0]).toEqual({ kind: "text", text: "morning standup" });
    expect(body.params.message.metadata).toEqual({
      scheduler_job_id: "gina-personal-daily",
      channel: "a2a",
      agent_name: "gina-personal",
    });
  });

  test("forwards X-API-Key when api_key is configured", async () => {
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  gina:
    url: http://gina:7870/a2a
    api_key: my-key
`);
    const { fn, calls } = makeFetchMock();
    new A2ADeliveryPlugin(workspaceDir, { fetch: fn }).install(bus);

    fireCron(bus, "cron.gina.daily", {
      content: "ping",
      channel: "a2a",
      agent_name: "gina",
    });
    await flush();

    expect(calls[0].headers["X-API-Key"]).toBe("my-key");
    expect(calls[0].headers["Authorization"]).toBeUndefined();
  });

  test("expands ${ENV_VAR} in url and auth fields", async () => {
    process.env.A2A_TEST_BEARER = "env-bearer-value";
    process.env.A2A_TEST_HOST = "env-host";
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  agent:
    url: http://\${A2A_TEST_HOST}:7870/a2a
    bearer_token: \${A2A_TEST_BEARER}
`);
    const { fn, calls } = makeFetchMock();
    new A2ADeliveryPlugin(workspaceDir, { fetch: fn }).install(bus);

    fireCron(bus, "cron.agent.x", {
      content: "x",
      channel: "a2a",
      agent_name: "agent",
    });
    await flush();

    expect(calls[0].url).toBe("http://env-host:7870/a2a");
    expect(calls[0].headers["Authorization"]).toBe("Bearer env-bearer-value");

    delete process.env.A2A_TEST_BEARER;
    delete process.env.A2A_TEST_HOST;
  });

  test("ignores cron events without channel=a2a", async () => {
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  gina:
    url: http://gina:7870/a2a
`);
    const { fn, calls } = makeFetchMock();
    new A2ADeliveryPlugin(workspaceDir, { fetch: fn }).install(bus);

    fireCron(bus, "cron.gina.daily", { content: "x", channel: "signal", agent_name: "gina" });
    fireCron(bus, "cron.gina.other", { content: "x" }); // no channel
    await flush();

    expect(calls).toHaveLength(0);
  });

  test("drops a2a cron with no agent_name (loud error)", async () => {
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  gina:
    url: http://gina:7870/a2a
`);
    const { fn, calls } = makeFetchMock();
    new A2ADeliveryPlugin(workspaceDir, { fetch: fn }).install(bus);

    fireCron(bus, "cron.unknown", { content: "x", channel: "a2a" });
    await flush();

    expect(calls).toHaveLength(0);
  });

  test("drops a2a cron when agent_name has no configured target", async () => {
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  configured-agent:
    url: http://configured:7870/a2a
`);
    const { fn, calls } = makeFetchMock();
    new A2ADeliveryPlugin(workspaceDir, { fetch: fn }).install(bus);

    fireCron(bus, "cron.unconfigured.x", {
      content: "x",
      channel: "a2a",
      agent_name: "unconfigured-agent",
    });
    await flush();

    expect(calls).toHaveLength(0);
  });

  test("missing a2a.yaml is a no-op (plugin still installs cleanly)", async () => {
    const { fn, calls } = makeFetchMock();
    const plugin = new A2ADeliveryPlugin(workspaceDir, { fetch: fn });
    plugin.install(bus); // no a2a.yaml in workspaceDir

    fireCron(bus, "cron.x", { content: "x", channel: "a2a", agent_name: "anything" });
    await flush();

    expect(calls).toHaveLength(0);
  });
});

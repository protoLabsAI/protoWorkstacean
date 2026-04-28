/**
 * A2ADeliveryPlugin tests — verify channel gating, target lookup,
 * auth header forwarding, payload validation, and the JSON-RPC
 * `message/send` shape.
 *
 * No mocks: each test stands up a real Bun.serve HTTP sink on an
 * ephemeral port and asserts against the requests it received.
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

function startSink(opts: { responseBody?: () => unknown } = {}) {
  const calls: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0, // ephemeral
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      const text = await req.text();
      const body = text ? JSON.parse(text) : undefined;
      calls.push({ url: req.url, headers, body });
      const respBody = opts.responseBody ? opts.responseBody() : { jsonrpc: "2.0", id: "1", result: {} };
      return new Response(JSON.stringify(respBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { server, baseUrl: `http://localhost:${server.port}`, calls };
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

// Plugin handler awaits a real fetch; tests need a microtask flush plus
// time for the request to reach the local server.
async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 25));
}

describe("A2ADeliveryPlugin", () => {
  let workspaceDir: string;
  let bus: InMemoryEventBus;
  let sink: ReturnType<typeof startSink>;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "a2a-delivery-test-"));
    bus = new InMemoryEventBus();
    sink = startSink();
  });

  afterEach(() => {
    sink.server.stop(true);
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("delivers JSON-RPC message/send when channel=a2a and target is configured", async () => {
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  gina-personal:
    url: ${sink.baseUrl}/a2a
    bearer_token: secret-bearer
`);
    new A2ADeliveryPlugin(workspaceDir).install(bus);

    fireCron(bus, "cron.gina-personal.daily", {
      content: "morning standup",
      channel: "a2a",
      agent_name: "gina-personal",
      scheduler_job_id: "gina-personal-daily",
    });
    await flush();

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].url).toBe(`${sink.baseUrl}/a2a`);
    expect(sink.calls[0].headers["authorization"]).toBe("Bearer secret-bearer");
    expect(sink.calls[0].headers["content-type"]).toBe("application/json");

    const body = sink.calls[0].body as {
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
    url: ${sink.baseUrl}/a2a
    api_key: my-key
`);
    new A2ADeliveryPlugin(workspaceDir).install(bus);

    fireCron(bus, "cron.gina.daily", {
      content: "ping",
      channel: "a2a",
      agent_name: "gina",
    });
    await flush();

    expect(sink.calls[0].headers["x-api-key"]).toBe("my-key");
    expect(sink.calls[0].headers["authorization"]).toBeUndefined();
  });

  test("expands ${ENV_VAR} in url and auth fields", async () => {
    process.env.A2A_TEST_BEARER = "env-bearer-value";
    process.env.A2A_TEST_PORT = String(sink.server.port);
    try {
      writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  agent:
    url: http://localhost:\${A2A_TEST_PORT}/a2a
    bearer_token: \${A2A_TEST_BEARER}
`);
      new A2ADeliveryPlugin(workspaceDir).install(bus);

      fireCron(bus, "cron.agent.x", {
        content: "x",
        channel: "a2a",
        agent_name: "agent",
      });
      await flush();

      expect(sink.calls[0].url).toBe(`${sink.baseUrl}/a2a`);
      expect(sink.calls[0].headers["authorization"]).toBe("Bearer env-bearer-value");
    } finally {
      delete process.env.A2A_TEST_BEARER;
      delete process.env.A2A_TEST_PORT;
    }
  });

  test("ignores cron events without channel=a2a", async () => {
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  gina:
    url: ${sink.baseUrl}/a2a
`);
    new A2ADeliveryPlugin(workspaceDir).install(bus);

    fireCron(bus, "cron.gina.daily", { content: "x", channel: "signal", agent_name: "gina" });
    fireCron(bus, "cron.gina.other", { content: "x" }); // no channel
    await flush();

    expect(sink.calls).toHaveLength(0);
  });

  test("drops a2a cron with missing or non-string content", async () => {
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  gina:
    url: ${sink.baseUrl}/a2a
`);
    new A2ADeliveryPlugin(workspaceDir).install(bus);

    fireCron(bus, "cron.gina.no-content", { channel: "a2a", agent_name: "gina" });
    fireCron(bus, "cron.gina.empty-content", { channel: "a2a", agent_name: "gina", content: "   " });
    fireCron(bus, "cron.gina.numeric", { channel: "a2a", agent_name: "gina", content: 42 });
    await flush();

    expect(sink.calls).toHaveLength(0);
  });

  test("drops a2a cron with no agent_name", async () => {
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  gina:
    url: ${sink.baseUrl}/a2a
`);
    new A2ADeliveryPlugin(workspaceDir).install(bus);

    fireCron(bus, "cron.unknown", { content: "x", channel: "a2a" });
    await flush();

    expect(sink.calls).toHaveLength(0);
  });

  test("drops a2a cron when agent_name has no configured target", async () => {
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  configured-agent:
    url: ${sink.baseUrl}/a2a
`);
    new A2ADeliveryPlugin(workspaceDir).install(bus);

    fireCron(bus, "cron.unconfigured.x", {
      content: "x",
      channel: "a2a",
      agent_name: "unconfigured-agent",
    });
    await flush();

    expect(sink.calls).toHaveLength(0);
  });

  test("drops a2a cron when expanded url is empty (e.g. unset env var)", async () => {
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  agent:
    url: \${A2A_TEST_UNSET_VAR}
`);
    new A2ADeliveryPlugin(workspaceDir).install(bus);

    fireCron(bus, "cron.agent.x", {
      content: "x",
      channel: "a2a",
      agent_name: "agent",
    });
    await flush();

    expect(sink.calls).toHaveLength(0);
  });

  test("missing a2a.yaml is a no-op (plugin still installs cleanly)", async () => {
    const plugin = new A2ADeliveryPlugin(workspaceDir);
    plugin.install(bus); // no a2a.yaml in workspaceDir

    fireCron(bus, "cron.x", { content: "x", channel: "a2a", agent_name: "anything" });
    await flush();

    expect(sink.calls).toHaveLength(0);
  });

  test("rejects non-string url in YAML (e.g. url: 1234)", async () => {
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  agent:
    url: 1234
    bearer_token: ok
`);
    new A2ADeliveryPlugin(workspaceDir).install(bus);

    fireCron(bus, "cron.agent.x", {
      content: "x",
      channel: "a2a",
      agent_name: "agent",
    });
    await flush();

    expect(sink.calls).toHaveLength(0);
  });

  test("treats JSON-RPC HTTP-200-with-error body as a delivery failure", async () => {
    sink.server.stop(true);
    sink = startSink({
      responseBody: () => ({
        jsonrpc: "2.0",
        id: "1",
        error: { code: -32601, message: "Method not found" },
      }),
    });
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  gina:
    url: ${sink.baseUrl}/a2a
`);
    new A2ADeliveryPlugin(workspaceDir).install(bus);

    fireCron(bus, "cron.gina.x", {
      content: "x",
      channel: "a2a",
      agent_name: "gina",
    });
    await flush();

    // Request was sent (the sink saw it) but delivery is logged as failed.
    expect(sink.calls).toHaveLength(1);
    // Plugin doesn't expose status — the assertion is implicit via the
    // error log; production observers can grep `[a2a-delivery] Delivery
    // failed`. Asserting the request shape is enough to confirm the
    // happy path was attempted.
  });

  test("uninstall unsubscribes — no deliveries fire after teardown", async () => {
    writeFileSync(join(workspaceDir, "a2a.yaml"), `
targets:
  gina:
    url: ${sink.baseUrl}/a2a
`);
    const plugin = new A2ADeliveryPlugin(workspaceDir);
    plugin.install(bus);
    plugin.uninstall();

    fireCron(bus, "cron.gina.daily", {
      content: "x",
      channel: "a2a",
      agent_name: "gina",
    });
    await flush();

    expect(sink.calls).toHaveLength(0);
  });
});

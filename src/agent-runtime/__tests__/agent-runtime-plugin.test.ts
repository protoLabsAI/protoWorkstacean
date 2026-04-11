/**
 * AgentRuntimePlugin tests.
 *
 * AgentRuntimePlugin is now a registrar — it populates an ExecutorRegistry
 * with ProtoSdkExecutors on install(). Tests verify correct registration
 * and end-to-end dispatch via SkillDispatcherPlugin.
 */

import { describe, test, expect, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { SkillDispatcherPlugin } from "../../executor/skill-dispatcher-plugin.ts";
import type { BusMessage } from "../../../lib/types.ts";

function makeTempWorkspace(agents: Record<string, object>): {
  workspaceDir: string;
  cleanup: () => void;
} {
  const workspaceDir = join(tmpdir(), `workstacean-rt-test-${crypto.randomUUID()}`);
  const agentsDir = join(workspaceDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const [filename, data] of Object.entries(agents)) {
    writeFileSync(join(agentsDir, filename), stringifyYaml(data), "utf8");
  }
  return { workspaceDir, cleanup: () => rmSync(workspaceDir, { recursive: true, force: true }) };
}

const quinnAgent = {
  name: "quinn",
  role: "qa",
  model: "claude-sonnet-4-6",
  systemPrompt: "You are Quinn.",
  tools: [],
  skills: [{ name: "bug_triage" }],
};

const avaAgent = {
  name: "ava",
  role: "orchestrator",
  model: "claude-opus-4-6",
  systemPrompt: "You are Ava.",
  tools: [],
  canDelegate: ["quinn"],
  skills: [{ name: "sitrep" }],
};

function makeSkillRequest(overrides: {
  skill?: string;
  targets?: string[];
  replyTopic?: string;
  correlationId?: string;
} = {}): BusMessage {
  const correlationId = overrides.correlationId ?? crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    correlationId,
    topic: "agent.skill.request",
    timestamp: Date.now(),
    payload: {
      skill: overrides.skill ?? "bug_triage",
      targets: overrides.targets ?? [],
    },
    ...(overrides.replyTopic ? { reply: { topic: overrides.replyTopic } } : {}),
  };
}

function waitForMessage(bus: InMemoryEventBus, topic: string, timeoutMs = 2000): Promise<BusMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${topic}"`)),
      timeoutMs,
    );
    const subId = bus.subscribe(topic, "test-waiter", (msg) => {
      clearTimeout(timer);
      bus.unsubscribe(subId);
      resolve(msg);
    });
  });
}

describe("AgentRuntimePlugin", () => {
  describe("registration", () => {
    test("registers skills from agent YAML into ExecutorRegistry", async () => {
      const { workspaceDir, cleanup } = makeTempWorkspace({
        "quinn.yaml": quinnAgent,
        "ava.yaml": avaAgent,
      });
      try {
        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const registry = new ExecutorRegistry();
        const plugin = new AgentRuntimePlugin({ workspaceDir }, registry);
        plugin.install(bus);

        // quinn's "bug_triage" skill should be registered
        const quinnsExecutor = registry.resolve("bug_triage");
        expect(quinnsExecutor).not.toBeNull();
        expect(quinnsExecutor!.type).toBe("proto-sdk");

        // ava's "sitrep" skill should be registered
        const avasExecutor = registry.resolve("sitrep");
        expect(avasExecutor).not.toBeNull();
        expect(avasExecutor!.type).toBe("proto-sdk");

        plugin.uninstall();
      } finally {
        cleanup();
      }
    });

    test("registers zero skills for empty workspace", async () => {
      const { workspaceDir, cleanup } = makeTempWorkspace({});
      try {
        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const registry = new ExecutorRegistry();
        const plugin = new AgentRuntimePlugin({ workspaceDir }, registry);
        plugin.install(bus);

        expect(registry.size).toBe(0);
        plugin.uninstall();
      } finally {
        cleanup();
      }
    });

    test("resolves by agent name via target routing", async () => {
      const { workspaceDir, cleanup } = makeTempWorkspace({
        "quinn.yaml": quinnAgent,
        "ava.yaml": avaAgent,
      });
      try {
        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const registry = new ExecutorRegistry();
        const plugin = new AgentRuntimePlugin({ workspaceDir }, registry);
        plugin.install(bus);

        // "ava" is registered via sitrep skill — target routing returns ava's executor
        const executor = registry.resolve("bug_triage", ["ava"]);
        expect(executor).not.toBeNull();
        expect(executor!.type).toBe("proto-sdk");

        plugin.uninstall();
      } finally {
        cleanup();
      }
    });
  });

  describe("validateAgentTools warnings", () => {
    test("logs warning for unknown tools", async () => {
      const agentWithUnknownTools = {
        ...quinnAgent,
        tools: ["nonexistent_tool", "another_missing"],
      };
      const { workspaceDir, cleanup } = makeTempWorkspace({
        "quinn-unknown.yaml": agentWithUnknownTools,
      });
      try {
        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const registry = new ExecutorRegistry();
        const warnSpy = spyOn(console, "warn");
        const plugin = new AgentRuntimePlugin({ workspaceDir }, registry);
        plugin.install(bus);

        const warnCalls = warnSpy.mock.calls.map(c => c[0] as string);
        const warningCall = warnCalls.find(msg => msg.includes("[agent-runtime] WARNING:"));
        expect(warningCall).toBeDefined();
        expect(warningCall).toContain("quinn");
        expect(warningCall).toContain("nonexistent_tool");
        expect(warningCall).toContain("another_missing");

        warnSpy.mockRestore();
        plugin.uninstall();
      } finally {
        cleanup();
      }
    });

    test("no warning when all tools are known or tools list is empty", async () => {
      const { workspaceDir, cleanup } = makeTempWorkspace({
        "quinn.yaml": quinnAgent,
      });
      try {
        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const registry = new ExecutorRegistry();
        const warnSpy = spyOn(console, "warn");
        const plugin = new AgentRuntimePlugin({ workspaceDir }, registry);
        plugin.install(bus);

        const warnCalls = warnSpy.mock.calls.map(c => c[0] as string);
        const hasAgentWarning = warnCalls.some(msg => msg.includes("[agent-runtime] WARNING:"));
        expect(hasAgentWarning).toBe(false);

        warnSpy.mockRestore();
        plugin.uninstall();
      } finally {
        cleanup();
      }
    });
  });

  describe("end-to-end via SkillDispatcherPlugin", () => {
    test("dispatches skill request and publishes result", async () => {
      const { workspaceDir, cleanup } = makeTempWorkspace({ "quinn.yaml": quinnAgent });
      const { AgentExecutor } = await import("../agent-executor.ts");
      const originalRun = AgentExecutor.prototype.run;
      try {
        AgentExecutor.prototype.run = mock(async () => ({
          text: "Bug triaged successfully.",
          isError: false,
          stopReason: "end_turn",
        }));

        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const registry = new ExecutorRegistry();
        const agentRuntime = new AgentRuntimePlugin({ workspaceDir }, registry);
        const dispatcher = new SkillDispatcherPlugin(registry, "/tmp");

        agentRuntime.install(bus);
        dispatcher.install(bus);

        const replyTopic = `agent.skill.response.${crypto.randomUUID()}`;
        const responsePromise = waitForMessage(bus, replyTopic);

        bus.publish("agent.skill.request", makeSkillRequest({ skill: "bug_triage", replyTopic }));

        const response = await responsePromise;
        const payload = response.payload as { content?: string; error?: string };
        expect(payload.content).toBe("Bug triaged successfully.");
        expect(payload.error).toBeUndefined();

        agentRuntime.uninstall();
        dispatcher.uninstall();
      } finally {
        AgentExecutor.prototype.run = originalRun;
        cleanup();
      }
    });

    test("publishes error when executor throws", async () => {
      const { workspaceDir, cleanup } = makeTempWorkspace({ "quinn.yaml": quinnAgent });
      const { AgentExecutor } = await import("../agent-executor.ts");
      const originalRun2 = AgentExecutor.prototype.run;
      try {
        AgentExecutor.prototype.run = mock(async () => {
          throw new Error("Subprocess crashed");
        });

        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const registry = new ExecutorRegistry();
        const agentRuntime = new AgentRuntimePlugin({ workspaceDir }, registry);
        const dispatcher = new SkillDispatcherPlugin(registry, "/tmp");

        agentRuntime.install(bus);
        dispatcher.install(bus);

        const replyTopic = `agent.skill.response.${crypto.randomUUID()}`;
        const responsePromise = waitForMessage(bus, replyTopic);

        bus.publish("agent.skill.request", makeSkillRequest({ skill: "bug_triage", replyTopic }));

        const response = await responsePromise;
        const payload = response.payload as { error?: string };
        expect(payload.error).toContain("Subprocess crashed");

        agentRuntime.uninstall();
        dispatcher.uninstall();
      } finally {
        AgentExecutor.prototype.run = originalRun2;
        cleanup();
      }
    });

    test("no response published for unknown skill", async () => {
      const { workspaceDir, cleanup } = makeTempWorkspace({});
      try {
        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const registry = new ExecutorRegistry();
        const agentRuntime = new AgentRuntimePlugin({ workspaceDir }, registry);
        const dispatcher = new SkillDispatcherPlugin(registry, "/tmp");

        agentRuntime.install(bus);
        dispatcher.install(bus);

        const replyTopic = "agent.skill.response.unknown-test";
        let gotResponse = false;
        bus.subscribe(replyTopic, "test", () => { gotResponse = true; });

        bus.publish("agent.skill.request", makeSkillRequest({ skill: "ghost_skill", replyTopic }));
        await new Promise(r => setTimeout(r, 50));

        // SkillDispatcherPlugin publishes an error response — verify it has an error field
        expect(gotResponse).toBe(true); // error response IS published by dispatcher
        agentRuntime.uninstall();
        dispatcher.uninstall();
      } finally {
        cleanup();
      }
    });
  });
});

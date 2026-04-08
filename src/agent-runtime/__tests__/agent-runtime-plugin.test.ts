/**
 * AgentRuntimePlugin integration tests.
 *
 * These tests verify the plugin's routing and response publishing behaviour
 * without spawning a real proto CLI subprocess. The executor is stubbed via
 * a lightweight fake workspace + mocked AgentExecutor.
 *
 * NOTE: AgentExecutor.run() is patched at the module level using Bun's mock
 * system so we never touch the LLM gateway or SDK subprocess.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import type { BusMessage } from "../../../lib/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempWorkspace(agents: Record<string, object>): {
  workspaceDir: string;
  cleanup: () => void;
} {
  const workspaceDir = join(tmpdir(), `workstacean-plugin-test-${crypto.randomUUID()}`);
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

function makeSkillRequest(
  overrides: Partial<{
    skill: string;
    targets: string[];
    runId: string;
    replyTopic: string;
  }> = {},
): BusMessage {
  const runId = overrides.runId ?? crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    correlationId: runId,
    topic: "agent.skill.request",
    timestamp: Date.now(),
    payload: {
      skill: overrides.skill ?? "bug_triage",
      targets: overrides.targets ?? [],
      runId,
    },
    ...(overrides.replyTopic
      ? { reply: { topic: overrides.replyTopic } }
      : {}),
  };
}

/** Collect the first message published on a topic within a timeout. */
function waitForMessage(bus: InMemoryEventBus, topic: string, timeoutMs = 3000): Promise<BusMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for message on "${topic}"`)),
      timeoutMs,
    );
    const subId = bus.subscribe(topic, "test-waiter", (msg) => {
      clearTimeout(timer);
      bus.unsubscribe(subId);
      resolve(msg);
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AgentRuntimePlugin", () => {
  describe("tool registry", () => {
    test("registers all built-in bus tools on install", async () => {
      const { workspaceDir, cleanup } = makeTempWorkspace({});
      try {
        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const plugin = new AgentRuntimePlugin({ workspaceDir });
        plugin.install(bus);

        // Check plugin metadata
        expect(plugin.name).toBe("agent-runtime");
        expect(plugin.capabilities).toContain("in-process-agents");

        plugin.uninstall();
      } finally {
        cleanup();
      }
    });
  });

  describe("agent resolution", () => {
    test("resolves agent by skill name and publishes response", async () => {
      const { workspaceDir, cleanup } = makeTempWorkspace({ "quinn.yaml": quinnAgent });
      try {
        // Patch AgentExecutor.run to avoid real subprocess
        const { AgentExecutor } = await import("../agent-executor.ts");
        const runMock = mock(async () => ({
          text: "Bug triaged successfully.",
          isError: false,
          stopReason: "end_turn",
        }));
        AgentExecutor.prototype.run = runMock;

        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const plugin = new AgentRuntimePlugin({ workspaceDir });
        plugin.install(bus);

        const runId = crypto.randomUUID();
        const replyTopic = `agent.skill.response.${runId}`;
        const responsePromise = waitForMessage(bus, replyTopic);

        bus.publish("agent.skill.request", makeSkillRequest({ skill: "bug_triage", runId, replyTopic }));

        const response = await responsePromise;
        const payload = response.payload as { result?: string; error?: string };

        expect(payload.result).toBe("Bug triaged successfully.");
        expect(payload.error).toBeUndefined();

        plugin.uninstall();
      } finally {
        cleanup();
      }
    });

    test("resolves agent by explicit target name", async () => {
      const { workspaceDir, cleanup } = makeTempWorkspace({
        "ava.yaml": avaAgent,
        "quinn.yaml": quinnAgent,
      });
      try {
        const { AgentExecutor } = await import("../agent-executor.ts");
        AgentExecutor.prototype.run = mock(async () => ({
          text: "Sitrep complete.",
          isError: false,
        }));

        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const plugin = new AgentRuntimePlugin({ workspaceDir });
        plugin.install(bus);

        const runId = crypto.randomUUID();
        const replyTopic = `agent.skill.response.${runId}`;
        const responsePromise = waitForMessage(bus, replyTopic);

        // Target "ava" explicitly even though skill is "bug_triage" (quinn's skill)
        bus.publish(
          "agent.skill.request",
          makeSkillRequest({ skill: "bug_triage", targets: ["ava"], runId, replyTopic }),
        );

        const response = await responsePromise;
        const payload = response.payload as { result?: string };
        expect(payload.result).toBe("Sitrep complete.");

        plugin.uninstall();
      } finally {
        cleanup();
      }
    });

    test("does not publish response for unknown agents (falls through to SkillBroker)", async () => {
      const { workspaceDir, cleanup } = makeTempWorkspace({});
      try {
        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const plugin = new AgentRuntimePlugin({ workspaceDir });
        plugin.install(bus);

        let gotResponse = false;
        bus.subscribe("agent.skill.response.#", "test", () => { gotResponse = true; });

        bus.publish(
          "agent.skill.request",
          makeSkillRequest({ skill: "unknown_skill", targets: ["ghost-agent"] }),
        );

        // Give it a tick to respond (it should not)
        await new Promise(r => setTimeout(r, 50));
        expect(gotResponse).toBe(false);

        plugin.uninstall();
      } finally {
        cleanup();
      }
    });

    test("publishes error response when executor throws", async () => {
      const { workspaceDir, cleanup } = makeTempWorkspace({ "quinn.yaml": quinnAgent });
      try {
        const { AgentExecutor } = await import("../agent-executor.ts");
        AgentExecutor.prototype.run = mock(async () => {
          throw new Error("Subprocess crashed");
        });

        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const plugin = new AgentRuntimePlugin({ workspaceDir });
        plugin.install(bus);

        const runId = crypto.randomUUID();
        const replyTopic = `agent.skill.response.${runId}`;
        const responsePromise = waitForMessage(bus, replyTopic);

        bus.publish("agent.skill.request", makeSkillRequest({ skill: "bug_triage", runId, replyTopic }));

        const response = await responsePromise;
        const payload = response.payload as { error?: string };
        expect(payload.error).toContain("Subprocess crashed");

        plugin.uninstall();
      } finally {
        cleanup();
      }
    });
  });

  describe("uninstall", () => {
    test("stops receiving messages after uninstall", async () => {
      const { workspaceDir, cleanup } = makeTempWorkspace({ "quinn.yaml": quinnAgent });
      try {
        const { AgentExecutor } = await import("../agent-executor.ts");
        let callCount = 0;
        AgentExecutor.prototype.run = mock(async () => {
          callCount++;
          return { text: "done", isError: false };
        });

        const { AgentRuntimePlugin } = await import("../agent-runtime-plugin.ts");
        const bus = new InMemoryEventBus();
        const plugin = new AgentRuntimePlugin({ workspaceDir });
        plugin.install(bus);
        plugin.uninstall();

        bus.publish("agent.skill.request", makeSkillRequest({ skill: "bug_triage" }));

        await new Promise(r => setTimeout(r, 50));
        expect(callCount).toBe(0);
      } finally {
        cleanup();
      }
    });
  });
});

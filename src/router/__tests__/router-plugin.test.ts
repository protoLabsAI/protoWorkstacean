import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import type { BusMessage } from "../../../lib/types.ts";
import { RouterPlugin } from "../router-plugin.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWorkspace(opts: {
  agents?: Record<string, object>;
  projects?: object[];
} = {}): { workspaceDir: string; cleanup: () => void } {
  const workspaceDir = join(tmpdir(), `router-test-${crypto.randomUUID()}`);
  const agentsDir = join(workspaceDir, "agents");
  mkdirSync(agentsDir, { recursive: true });

  for (const [file, data] of Object.entries(opts.agents ?? {})) {
    writeFileSync(join(agentsDir, file), stringifyYaml(data));
  }

  if (opts.projects) {
    writeFileSync(
      join(workspaceDir, "projects.yaml"),
      stringifyYaml({ projects: opts.projects }),
    );
  }

  return {
    workspaceDir,
    cleanup: () => rmSync(workspaceDir, { recursive: true, force: true }),
  };
}

const quinnAgent = {
  name: "quinn",
  role: "qa",
  model: "claude-sonnet-4-6",
  systemPrompt: "You are Quinn.",
  tools: [],
  skills: [
    { name: "bug_triage", keywords: ["bug", "broken", "error"] },
    { name: "pr_review",  keywords: ["pr", "review"] },
  ],
};

const avaAgent = {
  name: "ava",
  role: "orchestrator",
  model: "claude-opus-4-6",
  systemPrompt: "You are Ava.",
  tools: [],
  skills: [
    { name: "sitrep", keywords: ["status", "sitrep", "/sitrep"] },
  ],
};

function makeInbound(
  topic: string,
  payload: Record<string, unknown>,
  replyTopic?: string,
): BusMessage {
  return {
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    topic,
    timestamp: Date.now(),
    payload,
    ...(replyTopic ? { reply: { topic: replyTopic } } : {}),
  };
}

function waitForSkillRequest(bus: InMemoryEventBus, timeoutMs = 200): Promise<BusMessage | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bus.unsubscribe(subId);
      resolve(null);
    }, timeoutMs);
    const subId = bus.subscribe("agent.skill.request", "test-waiter", (msg) => {
      clearTimeout(timer);
      bus.unsubscribe(subId);
      resolve(msg);
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RouterPlugin", () => {
  describe("skillHint routing", () => {
    test("routes message with explicit skillHint to agent.skill.request", async () => {
      const { workspaceDir, cleanup } = makeWorkspace({ agents: { "quinn.yaml": quinnAgent } });
      try {
        // RouterPlugin imported statically at top of file
        const bus = new InMemoryEventBus();
        const plugin = new RouterPlugin({ workspaceDir });
        plugin.install(bus);

        const requestPromise = waitForSkillRequest(bus);
        bus.publish(
          "message.inbound.discord.123",
          makeInbound("message.inbound.discord.123", {
            content: "some message",
            skillHint: "bug_triage",
          }, "message.outbound.discord.123"),
        );

        const req = await requestPromise;
        expect(req).not.toBeNull();
        const p = req!.payload as Record<string, unknown>;
        expect(p.skill).toBe("bug_triage");
        expect(req!.reply?.topic).toBe("message.outbound.discord.123");

        plugin.uninstall();
      } finally {
        cleanup();
      }
    });
  });

  describe("keyword routing", () => {
    test("routes message with matching keyword to correct skill", async () => {
      const { workspaceDir, cleanup } = makeWorkspace({
        agents: { "quinn.yaml": quinnAgent, "ava.yaml": avaAgent },
      });
      try {
        // RouterPlugin imported statically at top of file
        const bus = new InMemoryEventBus();
        const plugin = new RouterPlugin({ workspaceDir });
        plugin.install(bus);

        const requestPromise = waitForSkillRequest(bus);
        bus.publish(
          "message.inbound.discord.456",
          makeInbound("message.inbound.discord.456", {
            content: "there is a bug in the checkout flow",
          }),
        );

        const req = await requestPromise;
        expect(req).not.toBeNull();
        const p = req!.payload as Record<string, unknown>;
        expect(p.skill).toBe("bug_triage");

        plugin.uninstall();
      } finally {
        cleanup();
      }
    });
  });

  describe("default skill", () => {
    test("routes to defaultSkill when nothing matches", async () => {
      const { workspaceDir, cleanup } = makeWorkspace({ agents: { "ava.yaml": avaAgent } });
      try {
        // RouterPlugin imported statically at top of file
        const bus = new InMemoryEventBus();
        const plugin = new RouterPlugin({ workspaceDir, defaultSkill: "sitrep" });
        plugin.install(bus);

        const requestPromise = waitForSkillRequest(bus);
        bus.publish(
          "message.inbound.discord.789",
          makeInbound("message.inbound.discord.789", {
            content: "completely unrelated xyz abc",
          }),
        );

        const req = await requestPromise;
        expect(req).not.toBeNull();
        const p = req!.payload as Record<string, unknown>;
        expect(p.skill).toBe("sitrep");
        expect((p as { _routed?: boolean })._routed).toBe(true);

        plugin.uninstall();
      } finally {
        cleanup();
      }
    });

    test("drops message when no skill matches and no default", async () => {
      const { workspaceDir, cleanup } = makeWorkspace({ agents: { "quinn.yaml": quinnAgent } });
      try {
        // RouterPlugin imported statically at top of file
        const bus = new InMemoryEventBus();
        const plugin = new RouterPlugin({ workspaceDir }); // no defaultSkill
        plugin.install(bus);

        const req = waitForSkillRequest(bus, 100);
        bus.publish(
          "message.inbound.discord.000",
          makeInbound("message.inbound.discord.000", {
            content: "completely unrelated xyz abc",
          }),
        );

        expect(await req).toBeNull();
        plugin.uninstall();
      } finally {
        cleanup();
      }
    });
  });

  describe("_routed guard", () => {
    test("does not re-route already-routed messages", async () => {
      const { workspaceDir, cleanup } = makeWorkspace({ agents: { "quinn.yaml": quinnAgent } });
      try {
        // RouterPlugin imported statically at top of file
        const bus = new InMemoryEventBus();
        const plugin = new RouterPlugin({ workspaceDir });
        plugin.install(bus);

        let count = 0;
        bus.subscribe("agent.skill.request", "counter", () => { count++; });

        // First message routes normally
        bus.publish(
          "message.inbound.discord.111",
          makeInbound("message.inbound.discord.111", {
            content: "there is a bug",
            skillHint: "bug_triage",
          }),
        );

        await new Promise(r => setTimeout(r, 80));

        // Second message is already _routed — should be dropped
        bus.publish(
          "message.inbound.discord.111",
          makeInbound("message.inbound.discord.111", {
            content: "there is a bug",
            skillHint: "bug_triage",
            _routed: true,
          }),
        );

        await new Promise(r => setTimeout(r, 80));
        expect(count).toBe(1);

        plugin.uninstall();
      } finally {
        cleanup();
      }
    });
  });

  describe("cron routing", () => {
    test("routes cron event with skillHint to agent.skill.request", async () => {
      const { workspaceDir, cleanup } = makeWorkspace({ agents: { "ava.yaml": avaAgent } });
      try {
        // RouterPlugin imported statically at top of file
        const bus = new InMemoryEventBus();
        const plugin = new RouterPlugin({ workspaceDir });
        plugin.install(bus);

        const requestPromise = waitForSkillRequest(bus);
        bus.publish("cron.daily-digest", {
          id: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          topic: "cron.daily-digest",
          timestamp: Date.now(),
          payload: {
            content: "Generate the daily digest",
            skillHint: "sitrep",
            channel: "discord",
            sender: "cron",
          },
        });

        const req = await requestPromise;
        expect(req).not.toBeNull();
        const p = req!.payload as Record<string, unknown>;
        expect(p.skill).toBe("sitrep");

        plugin.uninstall();
      } finally {
        cleanup();
      }
    });
  });

  describe("GitHub enrichment", () => {
    test("enriches GitHub message with projectSlug", async () => {
      const { workspaceDir, cleanup } = makeWorkspace({
        agents: { "quinn.yaml": quinnAgent },
        projects: [{
          slug: "my-project",
          github: "myorg/myrepo",
          status: "active",
          discord: { dev: "channel-123" },
        }],
      });
      try {
        // RouterPlugin imported statically at top of file
        const bus = new InMemoryEventBus();
        const plugin = new RouterPlugin({ workspaceDir });
        plugin.install(bus);

        const requestPromise = waitForSkillRequest(bus);
        bus.publish(
          "message.inbound.github.myorg.myrepo.pull_request.42",
          makeInbound("message.inbound.github.myorg.myrepo.pull_request.42", {
            skillHint: "pr_review",
            github: { owner: "myorg", repo: "myrepo", number: 42 },
          }),
        );

        const req = await requestPromise;
        expect(req).not.toBeNull();
        const p = req!.payload as Record<string, unknown>;
        expect(p.skill).toBe("pr_review");
        expect(p.projectSlug).toBe("my-project");

        plugin.uninstall();
      } finally {
        cleanup();
      }
    });
  });

  describe("uninstall", () => {
    test("stops routing after uninstall", async () => {
      const { workspaceDir, cleanup } = makeWorkspace({ agents: { "quinn.yaml": quinnAgent } });
      try {
        // RouterPlugin imported statically at top of file
        const bus = new InMemoryEventBus();
        const plugin = new RouterPlugin({ workspaceDir });
        plugin.install(bus);
        plugin.uninstall();

        const req = waitForSkillRequest(bus, 100);
        bus.publish(
          "message.inbound.discord.999",
          makeInbound("message.inbound.discord.999", { skillHint: "bug_triage" }),
        );
        expect(await req).toBeNull();
      } finally {
        cleanup();
      }
    });
  });
});

// ── DM conversation stickiness ────────────────────────────────────────────────

describe("RouterPlugin — DM conversation stickiness", () => {
  const quinnWithChat = {
    ...quinnAgent,
    skills: [
      { name: "chat", keywords: [] },
      { name: "bug_triage", keywords: ["bug", "broken", "error"] },
      { name: "pr_review",  keywords: ["pr", "review"] },
    ],
  };

  function makeDM(
    conversationId: string,
    content: string,
    replyTopic = "reply.dm",
  ): BusMessage {
    return {
      id: crypto.randomUUID(),
      correlationId: conversationId,
      topic: "message.inbound.discord.dm-channel-1",
      timestamp: Date.now(),
      payload: { content, isDM: true, sender: "user-1" },
      reply: { topic: replyTopic },
      source: { interface: "discord", userId: "user-1", channelId: "dm-channel-1" },
    };
  }

  test("DM turn 1 with keyword match routes correctly", async () => {
    const { workspaceDir, cleanup } = makeWorkspace({ agents: { "quinn.yaml": quinnWithChat } });
    try {
      const bus = new InMemoryEventBus();
      const plugin = new RouterPlugin({ workspaceDir });
      plugin.install(bus);

      const convId = crypto.randomUUID();
      const req = waitForSkillRequest(bus);
      bus.publish("message.inbound.discord.dm-channel-1", makeDM(convId, "there is a bug in the auth module"));
      const result = await req;

      expect(result).not.toBeNull();
      expect((result!.payload as Record<string, unknown>).skill).toBe("bug_triage");
      expect((result!.payload as Record<string, unknown>).targets).toEqual(["quinn"]);

      plugin.uninstall();
    } finally { cleanup(); }
  });

  test("DM turn 2 without keywords stays with same agent (sticky)", async () => {
    const { workspaceDir, cleanup } = makeWorkspace({ agents: { "quinn.yaml": quinnWithChat } });
    try {
      const bus = new InMemoryEventBus();
      const plugin = new RouterPlugin({ workspaceDir });
      plugin.install(bus);

      const convId = crypto.randomUUID();

      // Turn 1 — keyword match
      const req1 = waitForSkillRequest(bus);
      bus.publish("message.inbound.discord.dm-channel-1", makeDM(convId, "there is a bug in auth"));
      const result1 = await req1;
      expect(result1).not.toBeNull();
      expect((result1!.payload as Record<string, unknown>).skill).toBe("bug_triage");

      // Turn 2 — no keyword, should stay with quinn via stickiness
      const req2 = waitForSkillRequest(bus);
      bus.publish("message.inbound.discord.dm-channel-1", makeDM(convId, "can you look into this more?"));
      const result2 = await req2;
      expect(result2).not.toBeNull();
      expect((result2!.payload as Record<string, unknown>).targets).toEqual(["quinn"]);

      plugin.uninstall();
    } finally { cleanup(); }
  });

  test("DM with no keyword and ROUTER_DM_DEFAULT_AGENT routes to default agent", async () => {
    const { workspaceDir, cleanup } = makeWorkspace({ agents: { "quinn.yaml": quinnWithChat } });
    const orig = process.env.ROUTER_DM_DEFAULT_AGENT;
    process.env.ROUTER_DM_DEFAULT_AGENT = "quinn";
    process.env.ROUTER_DM_DEFAULT_SKILL = "chat";
    try {
      const bus = new InMemoryEventBus();
      const plugin = new RouterPlugin({ workspaceDir });
      plugin.install(bus);

      const convId = crypto.randomUUID();
      const req = waitForSkillRequest(bus);
      bus.publish("message.inbound.discord.dm-channel-1", makeDM(convId, "hey quinn, how are you?"));
      const result = await req;

      expect(result).not.toBeNull();
      expect((result!.payload as Record<string, unknown>).skill).toBe("chat");
      expect((result!.payload as Record<string, unknown>).targets).toEqual(["quinn"]);

      plugin.uninstall();
    } finally {
      if (orig === undefined) delete process.env.ROUTER_DM_DEFAULT_AGENT;
      else process.env.ROUTER_DM_DEFAULT_AGENT = orig;
      delete process.env.ROUTER_DM_DEFAULT_SKILL;
      cleanup();
    }
  });

  test("DM with no keyword and no default drops message", async () => {
    const { workspaceDir, cleanup } = makeWorkspace({ agents: { "quinn.yaml": quinnWithChat } });
    const orig = process.env.ROUTER_DM_DEFAULT_AGENT;
    delete process.env.ROUTER_DM_DEFAULT_AGENT;
    try {
      const bus = new InMemoryEventBus();
      const plugin = new RouterPlugin({ workspaceDir });
      plugin.install(bus);

      const convId = crypto.randomUUID();
      const req = waitForSkillRequest(bus, 100);
      bus.publish("message.inbound.discord.dm-channel-1", makeDM(convId, "just saying hello"));
      expect(await req).toBeNull();

      plugin.uninstall();
    } finally {
      if (orig !== undefined) process.env.ROUTER_DM_DEFAULT_AGENT = orig;
      cleanup();
    }
  });

  test("different conversations are independent (different convIds don't share session)", async () => {
    const { workspaceDir, cleanup } = makeWorkspace({ agents: { "quinn.yaml": quinnWithChat } });
    try {
      const bus = new InMemoryEventBus();
      const plugin = new RouterPlugin({ workspaceDir });
      plugin.install(bus);

      const convA = crypto.randomUUID();
      const convB = crypto.randomUUID();

      // Conv A: Turn 1 (keyword match — establishes sticky session)
      const req1 = waitForSkillRequest(bus);
      bus.publish("message.inbound.discord.dm-channel-1", makeDM(convA, "there is a bug here"));
      await req1;

      // Conv B: Turn 1 (no keyword) — should drop (different convId, no session)
      const req2 = waitForSkillRequest(bus, 100);
      bus.publish("message.inbound.discord.dm-channel-1", makeDM(convB, "just chatting"));
      expect(await req2).toBeNull();

      plugin.uninstall();
    } finally { cleanup(); }
  });
});

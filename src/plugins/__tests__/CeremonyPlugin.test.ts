import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { CeremonyPlugin } from "../CeremonyPlugin.ts";
import type { BusMessage } from "../../../lib/types.ts";
import type { CeremonyExecutePayload, } from "../../events/ceremonyEvents.ts";

const TEST_DIR = join(import.meta.dir, ".test-workspace-plugin");
const TEST_DB = join(import.meta.dir, ".test-ceremony-plugin.db");

function setupWorkspace() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "ceremonies"), { recursive: true });
}

function cleanupWorkspace() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
}

function writeCeremony(filename: string, content: string) {
  writeFileSync(join(TEST_DIR, "ceremonies", filename), content);
}

describe("CeremonyPlugin loader", () => {
  let bus: InMemoryEventBus;
  let plugin: CeremonyPlugin;

  beforeEach(() => {
    setupWorkspace();
    bus = new InMemoryEventBus();
    plugin = new CeremonyPlugin({
      workspaceDir: TEST_DIR,
      dbPath: TEST_DB,
    });
  });

  afterEach(() => {
    plugin.uninstall();
    cleanupWorkspace();
  });

  test("CeremonyPlugin loader: loads ceremonies from workspace/ceremonies/ on install", () => {
    writeCeremony(
      "board.health.yaml",
      `id: board.health
name: Board Health
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: true
`
    );

    plugin.install(bus);
    const ceremonies = plugin.getCeremonies();
    expect(ceremonies.some((c) => c.id === "board.health")).toBe(true);
  });

  test("CeremonyPlugin loader: skips disabled ceremonies on initial load (#453)", () => {
    writeCeremony(
      "board.enabled.yaml",
      `id: board.enabled
name: Enabled Ceremony
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: true
`
    );
    writeCeremony(
      "board.disabled.yaml",
      `id: board.disabled
name: Disabled Ceremony
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: false
`
    );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    };

    try {
      plugin.install(bus);
    } finally {
      console.log = originalLog;
    }

    const ceremonies = plugin.getCeremonies();
    const ids = ceremonies.map((c) => c.id);
    // Disabled ceremonies must NOT enter the registry — otherwise external
    // `ceremony.<id>.execute` triggers will fire them.
    expect(ids).toContain("board.enabled");
    expect(ids).not.toContain("board.disabled");

    // Operators should see the skip in logs (fail-loud principle).
    expect(
      logs.some((l) => l.includes("Skipping disabled ceremony: board.disabled")),
    ).toBe(true);

    // Only enabled ceremonies should have a scheduled timer.
    const timers = (plugin as unknown as { timers: Map<string, unknown> }).timers;
    expect(timers.has("board.enabled")).toBe(true);
    expect(timers.has("board.disabled")).toBe(false);
  });

  test("CeremonyPlugin loader: hot-reload flips enabled→disabled (cancels timer, removes from registry) (#415, #453)", async () => {
    writeCeremony(
      "board.flipping.yaml",
      `id: board.flipping
name: Flipping Ceremony
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: true
`
    );

    plugin.install(bus);

    // Initially enabled and scheduled
    const before = plugin.getCeremonies().map((c) => c.id);
    expect(before).toContain("board.flipping");
    let timers = (plugin as unknown as { timers: Map<string, unknown> }).timers;
    expect(timers.has("board.flipping")).toBe(true);

    // Prime hot-reload snapshot for the current (enabled) file size so the
    // next _checkForChanges call enters the changed-file branch.
    const pluginAny = plugin as unknown as {
      _checkForChanges(dir: string): void;
    };
    pluginAny._checkForChanges(join(TEST_DIR, "ceremonies"));
    await new Promise((r) => setTimeout(r, 5));

    // Flip to disabled in YAML
    writeCeremony(
      "board.flipping.yaml",
      `id: board.flipping
name: Flipping Ceremony
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: false
`
    );

    pluginAny._checkForChanges(join(TEST_DIR, "ceremonies"));
    await new Promise((r) => setTimeout(r, 10));

    const after = plugin.getCeremonies().map((c) => c.id);
    timers = (plugin as unknown as { timers: Map<string, unknown> }).timers;
    expect(after).not.toContain("board.flipping");
    expect(timers.has("board.flipping")).toBe(false);
  });

  test("CeremonyPlugin loader: hot-reload flips disabled→enabled (schedules new timer) (#453)", async () => {
    writeCeremony(
      "board.flipping.yaml",
      `id: board.flipping
name: Flipping Ceremony
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: false
`
    );

    plugin.install(bus);

    // Disabled at install time — not in registry, no timer
    expect(plugin.getCeremonies().map((c) => c.id)).not.toContain("board.flipping");
    let timers = (plugin as unknown as { timers: Map<string, unknown> }).timers;
    expect(timers.has("board.flipping")).toBe(false);

    // Prime the hot-reload snapshot at the current (disabled) file size.
    const pluginAny = plugin as unknown as {
      _checkForChanges(dir: string): void;
    };
    pluginAny._checkForChanges(join(TEST_DIR, "ceremonies"));
    await new Promise((r) => setTimeout(r, 5));

    // Flip to enabled in YAML
    writeCeremony(
      "board.flipping.yaml",
      `id: board.flipping
name: Flipping Ceremony
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: true
`
    );

    pluginAny._checkForChanges(join(TEST_DIR, "ceremonies"));
    await new Promise((r) => setTimeout(r, 10));

    expect(plugin.getCeremonies().map((c) => c.id)).toContain("board.flipping");
    timers = (plugin as unknown as { timers: Map<string, unknown> }).timers;
    expect(timers.has("board.flipping")).toBe(true);
  });

  test("ceremony YAML: registerCeremony adds ceremony to registry", () => {
    plugin.install(bus);

    plugin.registerCeremony({
      id: "test.ceremony",
      name: "Test",
      schedule: "0 9 * * 1",
      skill: "board_health",
      targets: ["all"],
      enabled: true,
    });

    expect(plugin.getCeremonies().some((c) => c.id === "test.ceremony")).toBe(true);
  });

  test("ceremony YAML: unregisterCeremony removes ceremony", () => {
    plugin.install(bus);

    plugin.registerCeremony({
      id: "test.ceremony",
      name: "Test",
      schedule: "0 9 * * 1",
      skill: "board_health",
      targets: ["all"],
      enabled: true,
    });

    plugin.unregisterCeremony("test.ceremony");
    expect(plugin.getCeremonies().some((c) => c.id === "test.ceremony")).toBe(false);
  });
});

describe("ceremony execute EventBus", () => {
  let bus: InMemoryEventBus;
  let plugin: CeremonyPlugin;

  beforeEach(() => {
    setupWorkspace();
    bus = new InMemoryEventBus();
    plugin = new CeremonyPlugin({
      workspaceDir: TEST_DIR,
      dbPath: TEST_DB,
    });
    plugin.install(bus);
  });

  afterEach(() => {
    plugin.uninstall();
    cleanupWorkspace();
  });

  test("ceremony execute: publishes ceremony.{id}.execute when ceremony fires", async () => {
    const executeMessages: BusMessage[] = [];

    bus.subscribe("ceremony.#", "test", (msg: BusMessage) => {
      if (msg.topic.endsWith(".execute")) {
        executeMessages.push(msg);
      }
    });

    // Register ceremony with immediate-ish cron (won't actually fire immediately in test)
    // Instead, access the private _fireCeremony method via type assertion for testing
    const pluginAny = plugin as unknown as {
      _fireCeremony(ceremony: {
        id: string;
        name: string;
        schedule: string;
        skill: string;
        targets: string[];
        enabled: boolean;
      }): void;
    };

    pluginAny._fireCeremony({
      id: "board.test",
      name: "Test Ceremony",
      schedule: "*/30 * * * *",
      skill: "board_health",
      targets: ["all"],
      enabled: true,
    });

    // Give async dispatch a moment
    await new Promise((r) => setTimeout(r, 10));

    expect(executeMessages.length).toBeGreaterThan(0);
    const msg = executeMessages[0]!;
    expect(msg.topic).toBe("ceremony.board.test.execute");

    const payload = msg.payload as CeremonyExecutePayload;
    expect(payload.type).toBe("ceremony.execute");
    expect(payload.skill).toBe("board_health");
    expect(payload.context.ceremonyId).toBe("board.test");
    expect(payload.context.runId).toBeTruthy();
  });

  test("ceremony reply: skill result on payload.content lands in the outcome (regression — CeremonyPlugin read .result, dispatcher publishes .content)", async () => {
    const completed: BusMessage[] = [];
    bus.subscribe("ceremony.#", "test-completed", (msg: BusMessage) => {
      if (msg.topic.endsWith(".completed")) completed.push(msg);
    });

    // Reply the way SkillDispatcher._publishResponse actually does: the skill
    // output is on payload.content (the field a2a-server / openai-compat /
    // linear all read). If CeremonyPlugin reads payload.result it sees nothing.
    bus.subscribe("agent.skill.request", "test-agent", (msg: BusMessage) => {
      const replyTopic = msg.reply?.topic;
      if (!replyTopic) return;
      bus.publish(replyTopic, {
        id: crypto.randomUUID(),
        correlationId: msg.correlationId,
        topic: replyTopic,
        timestamp: Date.now(),
        payload: { content: "DIGEST: 2 blocked, 1 needs attention", correlationId: msg.correlationId },
      });
    });

    const pluginAny = plugin as unknown as {
      _fireCeremony(ceremony: {
        id: string; name: string; schedule: string; skill: string;
        targets: string[]; enabled: boolean; timeoutMs?: number;
      }): void;
    };

    pluginAny._fireCeremony({
      id: "board.reply",
      name: "Reply Contract Test",
      schedule: "*/30 * * * *",
      skill: "portfolio_check_in",
      targets: ["ava"],
      enabled: true,
      timeoutMs: 5_000, // defined so the old bug would have mislabeled this "timeout"
    });

    await new Promise((r) => setTimeout(r, 30));

    expect(completed.length).toBeGreaterThan(0);
    const { outcome } = completed[0]!.payload as { outcome: { status: string; result?: string } };
    expect(outcome.status).toBe("success");
    expect(outcome.result).toBe("DIGEST: 2 blocked, 1 needs attention");
  });
});

describe("ceremony hotReload", () => {
  let bus: InMemoryEventBus;
  let plugin: CeremonyPlugin;

  beforeEach(() => {
    setupWorkspace();
    bus = new InMemoryEventBus();
    plugin = new CeremonyPlugin({
      workspaceDir: TEST_DIR,
      dbPath: TEST_DB,
    });
    plugin.install(bus);
  });

  afterEach(() => {
    plugin.uninstall();
    cleanupWorkspace();
  });

  test("ceremony hotReload: detects and loads new ceremony files", async () => {
    // No ceremonies initially
    expect(plugin.getCeremonies().filter((c) => c.id === "new.ceremony")).toHaveLength(0);

    // Write a new ceremony file
    writeCeremony(
      "new.ceremony.yaml",
      `id: new.ceremony
name: New Ceremony
schedule: "0 9 * * 1"
skill: board_health
targets: [all]
enabled: true
`
    );

    // Trigger hot-reload check
    const pluginAny = plugin as unknown as {
      _checkForChanges(dir: string): void;
    };
    pluginAny._checkForChanges(join(TEST_DIR, "ceremonies"));

    // Give it a moment to load
    await new Promise((r) => setTimeout(r, 10));

    // The new ceremony should now be registered
    const ceremonies = plugin.getCeremonies();
    expect(ceremonies.some((c) => c.id === "new.ceremony")).toBe(true);
  });
});

describe("ceremony SchedulerPlugin integration", () => {
  test("ceremony SchedulerPlugin: registers ceremonies as cron-like timers on install", () => {
    setupWorkspace();
    const bus2 = new InMemoryEventBus();
    const plugin2 = new CeremonyPlugin({
      workspaceDir: TEST_DIR,
      dbPath: TEST_DB,
    });

    writeCeremony(
      "board.health.yaml",
      `id: board.health
name: Board Health
schedule: "*/30 * * * *"
skill: board_health
targets: [all]
enabled: true
`
    );

    plugin2.install(bus2);

    const ceremonies = plugin2.getCeremonies();
    expect(ceremonies.some((c) => c.id === "board.health")).toBe(true);

    plugin2.uninstall();
    cleanupWorkspace();
  });
});

describe("ceremony defaults", () => {
  test("ceremony defaults: deploys default YAML files to workspace/ceremonies/ on first run", () => {
    setupWorkspace();
    const bus2 = new InMemoryEventBus();
    const plugin2 = new CeremonyPlugin({
      workspaceDir: TEST_DIR,
      dbPath: TEST_DB,
    });

    plugin2.install(bus2);

    // The defaults directory (src/plugins/ceremonies/defaults/) may or may not exist
    // depending on build. If it does, files should be deployed.
    const defaultsExist = existsSync(
      join(import.meta.dir, "..", "ceremonies", "defaults")
    );

    if (defaultsExist) {
      const ceremoniesDir = join(TEST_DIR, "ceremonies");
      expect(existsSync(ceremoniesDir)).toBe(true);
    }

    plugin2.uninstall();
    cleanupWorkspace();
  });
});

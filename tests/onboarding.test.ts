/**
 * Unit tests for OnboardingPlugin.
 *
 * Strategy:
 *  - mock.module() replaces ES modules before dynamic import
 *  - Real fs writes go to an OS temp dir per test
 *  - A minimal in-memory EventBus is used for pub/sub
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { EventBus, BusMessage } from "../lib/types.ts";

// ── Minimal EventBus ──────────────────────────────────────────────────────────

function makeTestBus() {
  const published: BusMessage[] = [];
  const handlers = new Map<string, ((msg: BusMessage) => void | Promise<void>)[]>();

  const bus: EventBus = {
    publish(topic: string, message: BusMessage) {
      published.push(message);
      const list = handlers.get(topic) ?? [];
      for (const h of list) h(message);
    },
    subscribe(pattern: string, _name: string, handler: (msg: BusMessage) => void | Promise<void>) {
      const list = handlers.get(pattern) ?? [];
      list.push(handler);
      handlers.set(pattern, list);
      return crypto.randomUUID();
    },
    unsubscribe() {},
    topics() { return []; },
    consumers() { return []; },
  };

  return { bus, published };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBusMsg(payload: Record<string, unknown>, replyTopic = "test.reply"): BusMessage {
  return {
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    topic: "message.inbound.onboard",
    timestamp: Date.now(),
    payload,
    reply: { topic: replyTopic },
  };
}

function findReply(published: BusMessage[], topic = "test.reply"): Record<string, unknown> | undefined {
  const msg = published.find(m => m.topic === topic);
  return msg?.payload as Record<string, unknown> | undefined;
}

function findComplete(published: BusMessage[]): BusMessage | undefined {
  return published.find(m => m.topic === "message.inbound.onboard.complete");
}

// ── Mock state (shared across mock.module factories) ──────────────────────────
//
// We deliberately do NOT mock `../lib/project-schema.ts`. `mock.module()`
// replacements in Bun's test runner persist for the entire process and bleed
// into other test files run in the same `bun test` invocation — when
// tests/project-schema.test.ts runs after this file in the same process, it
// would pick up the mocked `validateProjectEntry` (which returned the wrong
// success shape) and 12 tests would fail intermittently in CI. Tracked as #480.
// The real schema is fast and pure; tests construct payloads that satisfy it.

const _mocks = {
  makeGitHubAuth: null as unknown,
  createDriveFolder: null as unknown,
};

mock.module("../lib/github-auth.ts", () => ({
  makeGitHubAuth: (...args: unknown[]) => (_mocks.makeGitHubAuth as (...a: unknown[]) => unknown)(...args),
}));

mock.module("../lib/plugins/google.ts", () => ({
  createDriveFolder: (...args: unknown[]) => (_mocks.createDriveFolder as (...a: unknown[]) => unknown)(...args),
  getGoogleAccessToken: () => Promise.resolve(null),
  GooglePlugin: class {},
}));

// Import the plugin AFTER mock.module calls
const { OnboardingPlugin } = await import("../lib/plugins/onboarding.ts");

// ── Default env setup ─────────────────────────────────────────────────────────

const DEFAULT_ENV: Record<string, string> = {
  WORKSTACEAN_PUBLIC_URL: "https://ws.test",
  GITHUB_TOKEN: "ghp_test123",
  GITHUB_WEBHOOK_SECRET: "wh-secret",
};

function setEnv(overrides: Record<string, string | undefined> = {}) {
  const merged = { ...DEFAULT_ENV, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function clearEnv() {
  for (const k of Object.keys(DEFAULT_ENV)) delete process.env[k];
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
  delete process.env.QUINN_APP_ID;
  delete process.env.QUINN_APP_PRIVATE_KEY;
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe("OnboardingPlugin — Step 1: validate", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    setEnv();
    _mocks.makeGitHubAuth = mock(() => () => Promise.resolve("ghp_test"));
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    clearEnv();
  });

  test("rejects missing slug", async () => {
    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ title: "Test", github: "owner/repo" }));
    await new Promise(r => setTimeout(r, 50));

    const reply = findReply(published);
    expect(reply?.success).toBe(false);
    expect(reply?.step).toBe("validate");
  });

  test("rejects missing title", async () => {
    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "test-proj", github: "owner/repo" }));
    await new Promise(r => setTimeout(r, 50));

    const reply = findReply(published);
    expect(reply?.success).toBe(false);
    expect(reply?.step).toBe("validate");
  });

  test("rejects invalid github format (no slash)", async () => {
    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "test-proj", title: "Test", github: "badformat" }));
    await new Promise(r => setTimeout(r, 50));

    const reply = findReply(published);
    expect(reply?.success).toBe(false);
    expect(reply?.step).toBe("validate");
    expect(String(reply?.error)).toContain("owner/repo");
  });

  test("accepts valid request", async () => {
    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "test-proj", title: "Test", github: "owner/repo" }));
    await new Promise(r => setTimeout(r, 2000));

    const reply = findReply(published);
    expect(reply?.success).toBe(true);
  });
});

describe("OnboardingPlugin — Step 2: idempotency", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    setEnv();
    _mocks.makeGitHubAuth = mock(() => () => Promise.resolve("ghp_test"));
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    clearEnv();
  });

  test("skips pipeline if slug already in projects.yaml", async () => {
    const projectsPath = join(workspaceDir, "projects.yaml");
    writeFileSync(projectsPath, `projects:\n  - slug: existing-proj\n    title: Existing\n`, "utf8");

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "existing-proj", title: "Existing", github: "owner/repo" }));
    await new Promise(r => setTimeout(r, 100));

    const reply = findReply(published);
    expect(reply?.success).toBe(true);
    expect(reply?.status).toBe("already_onboarded");
    expect(reply?.step).toBe("idempotency");
  });

  test("proceeds if slug not in projects.yaml", async () => {
    const projectsPath = join(workspaceDir, "projects.yaml");
    writeFileSync(projectsPath, `projects:\n  - slug: other-proj\n    title: Other\n`, "utf8");

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "new-proj", title: "New", github: "owner/repo" }));
    await new Promise(r => setTimeout(r, 2000));

    const reply = findReply(published);
    expect(reply?.success).toBe(true);
    expect(reply?.status).toBe("onboarded");
  });
});

describe("OnboardingPlugin — Step 3: GitHub webhook", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    setEnv();
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    clearEnv();
  });

  test("skips when no GitHub auth configured", async () => {
    _mocks.makeGitHubAuth = mock(() => null);

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p3", title: "P3", github: "owner/repo" }));
    await new Promise(r => setTimeout(r, 100));

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.githubWebhook).toBe("skip");
  });

  test("success — creates GitHub webhook", async () => {
    _mocks.makeGitHubAuth = mock(() => () => Promise.resolve("ghp_valid"));

    const origFetch = global.fetch;
    global.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/repos/owner/repo/hooks")) {
        if (!init?.method || init.method === "GET") {
          return new Response(JSON.stringify([]), { status: 200 });
        } else {
          return new Response(JSON.stringify({ id: 42, config: { url: "https://ws.test/webhook/github" } }), { status: 201 });
        }
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p3", title: "P3", github: "owner/repo" }));
    await new Promise(r => setTimeout(r, 100));

    global.fetch = origFetch;

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.githubWebhook).toBe("ok");
  });

  test("already-registered — skips when webhook URL already exists", async () => {
    const webhookUrl = "https://ws.test/webhook/github";

    const origFetch = global.fetch;
    global.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/repos/owner/repo/hooks")) {
        return new Response(
          JSON.stringify([{ id: 1, config: { url: webhookUrl } }]),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    _mocks.makeGitHubAuth = mock(() => () => Promise.resolve("ghp_valid"));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p3", title: "P3", github: "owner/repo" }));
    await new Promise(r => setTimeout(r, 100));

    global.fetch = origFetch;

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.githubWebhook).toBe("skip");
  });

  test("bad token — fetch returns 401, step returns error", async () => {
    const origFetch = global.fetch;
    global.fetch = mock(async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;

    _mocks.makeGitHubAuth = mock(() => () => Promise.resolve("bad-token"));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p3", title: "P3", github: "owner/repo" }));
    await new Promise(r => setTimeout(r, 100));

    global.fetch = origFetch;

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.githubWebhook).toBe("error");
  });
});

describe("OnboardingPlugin — Step 4: Drive folder", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    setEnv();
    _mocks.makeGitHubAuth = mock(() => null);
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    clearEnv();
  });

  test("skips when Google credentials not set", async () => {
    _mocks.createDriveFolder = mock(() => Promise.resolve({ id: "folder-id", name: "T" }));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p4", title: "P4", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.driveFolder).toBe("skip");
    expect((_mocks.createDriveFolder as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("skips when google.yaml has no orgFolderId", async () => {
    setEnv({
      GOOGLE_CLIENT_ID: "gc-id",
      GOOGLE_CLIENT_SECRET: "gc-secret",
      GOOGLE_REFRESH_TOKEN: "gc-refresh",
    });
    writeFileSync(join(workspaceDir, "google.yaml"), `drive:\n  orgFolderId: ""\n`, "utf8");
    _mocks.createDriveFolder = mock(() => Promise.resolve({ id: "folder-id", name: "T" }));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p4", title: "P4", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.driveFolder).toBe("skip");
    expect((_mocks.createDriveFolder as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("creates Drive folder when credentials and orgFolderId present", async () => {
    setEnv({
      GOOGLE_CLIENT_ID: "gc-id",
      GOOGLE_CLIENT_SECRET: "gc-secret",
      GOOGLE_REFRESH_TOKEN: "gc-refresh",
    });
    writeFileSync(join(workspaceDir, "google.yaml"), `drive:\n  orgFolderId: "org-root-folder"\n`, "utf8");
    _mocks.createDriveFolder = mock(() => Promise.resolve({ id: "new-folder-id", name: "P4" }));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p4", title: "P4", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.driveFolder).toBe("ok");

    const complete = findComplete(published);
    const payload = complete?.payload as Record<string, unknown> | undefined;
    expect(payload?.driveFolderId).toBe("new-folder-id");
  });
});

describe("OnboardingPlugin — Step 5: projects.yaml write", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    setEnv();
    _mocks.makeGitHubAuth = mock(() => null);
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    clearEnv();
  });

  test("upsert on new — creates projects.yaml and appends entry", async () => {
    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({
      slug: "new-proj",
      title: "New Project",
      github: "org/new-proj",
    }));
    await new Promise(r => setTimeout(r, 100));

    const projectsPath = join(workspaceDir, "projects.yaml");
    expect(existsSync(projectsPath)).toBe(true);

    const content = readFileSync(projectsPath, "utf8");
    const parsed = parseYaml(content) as { projects: { slug: string }[] };
    expect(parsed.projects.some(p => p.slug === "new-proj")).toBe(true);

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.projectsYaml).toBe("ok");
  });

  test("upsert on existing file — appends without duplicate", async () => {
    const projectsPath = join(workspaceDir, "projects.yaml");
    writeFileSync(projectsPath, `projects:\n  - slug: existing-proj\n    title: Existing\n`, "utf8");

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({
      slug: "another-proj",
      title: "Another",
      github: "org/another",
    }));
    await new Promise(r => setTimeout(r, 100));

    const content = readFileSync(projectsPath, "utf8");
    const parsed = parseYaml(content) as { projects: { slug: string }[] };
    expect(parsed.projects.some(p => p.slug === "existing-proj")).toBe(true);
    expect(parsed.projects.some(p => p.slug === "another-proj")).toBe(true);
    expect(parsed.projects.filter(p => p.slug === "another-proj").length).toBe(1);
  });

  test("includes driveFolderId when Drive step succeeded", async () => {
    setEnv({
      GOOGLE_CLIENT_ID: "gc-id",
      GOOGLE_CLIENT_SECRET: "gc-secret",
      GOOGLE_REFRESH_TOKEN: "gc-refresh",
    });
    writeFileSync(join(workspaceDir, "google.yaml"), `drive:\n  orgFolderId: "root-id"\n`, "utf8");
    _mocks.createDriveFolder = mock(() => Promise.resolve({ id: "drive-folder-456", name: "P5" }));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p5b", title: "P5B", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const projectsPath = join(workspaceDir, "projects.yaml");
    const content = readFileSync(projectsPath, "utf8");
    const parsed = parseYaml(content) as {
      projects: { slug: string; googleWorkspace?: { driveFolderId?: string } }[];
    };
    const entry = parsed.projects.find(p => p.slug === "p5b");
    expect(entry?.googleWorkspace?.driveFolderId).toBe("drive-folder-456");
  });
});

describe("OnboardingPlugin — Full pipeline", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    setEnv();
    _mocks.makeGitHubAuth = mock(() => null);
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    clearEnv();
  });

  test("all steps execute and bus publishes message.inbound.onboard.complete", async () => {
    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({
      slug: "full-pipeline",
      title: "Full Pipeline",
      github: "org/full",
      team: "dev",
      agents: ["ava", "quinn"],
      discord: { dev: "C12345" },
    }));
    await new Promise(r => setTimeout(r, 150));

    const complete = findComplete(published);
    expect(complete).toBeDefined();

    const reply = findReply(published);
    expect(reply?.success).toBe(true);
    expect(reply?.step).toBe("complete");
    expect(reply?.slug).toBe("full-pipeline");

    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.githubWebhook).toBeDefined();
    expect(steps?.driveFolder).toBeDefined();
    expect(steps?.projectsYaml).toBeDefined();
  });

  test("complete payload includes step summary", async () => {
    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "fp2", title: "FP2", github: "o/r" }));
    await new Promise(r => setTimeout(r, 150));

    const reply = findReply(published);
    expect(typeof reply?.summary).toBe("string");
    expect(String(reply?.summary)).toContain("FP2");
  });
});

describe("OnboardingPlugin — Idempotency (full run twice)", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    setEnv();
    _mocks.makeGitHubAuth = mock(() => null);
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    clearEnv();
  });

  test("second run returns already_onboarded, no duplicate in projects.yaml", async () => {
    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    const msg1 = makeBusMsg({ slug: "idem-proj", title: "Idempotent", github: "o/r" });
    bus.publish("message.inbound.onboard", msg1);
    await new Promise(r => setTimeout(r, 100));

    const msg2 = makeBusMsg({ slug: "idem-proj", title: "Idempotent", github: "o/r" });
    bus.publish("message.inbound.onboard", msg2);
    await new Promise(r => setTimeout(r, 100));

    const projectsPath = join(workspaceDir, "projects.yaml");
    const content = readFileSync(projectsPath, "utf8");
    const parsed = parseYaml(content) as { projects: { slug: string }[] };
    expect(parsed.projects.filter(p => p.slug === "idem-proj").length).toBe(1);

    const replies = published.filter(m => m.topic === "test.reply");
    expect(replies.length).toBe(2);
    const secondReply = replies[1].payload as Record<string, unknown>;
    expect(secondReply.status).toBe("already_onboarded");
  });
});

describe("OnboardingPlugin — Error handling", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    setEnv();
    _mocks.makeGitHubAuth = mock(() => null);
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    clearEnv();
  });

  test("fatal step error (projects.yaml schema fail) aborts pipeline", async () => {
    // Construct a request whose constructed entry will fail the real
    // ProjectEntrySchema. ProjectDiscordChannelSchema is union(string, object{
    // channelId, webhook? }); a bare numeric `dev` value satisfies neither
    // branch, so projects_yaml step rejects with a schema error.
    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({
      slug: "fatal-test",
      title: "Fatal",
      github: "o/r",
      discord: { dev: 12345 as unknown as string },
    }));
    await new Promise(r => setTimeout(r, 150));

    const reply = findReply(published);
    expect(reply?.success).toBe(false);
    expect(reply?.step).toBe("projects_yaml");
    expect(findComplete(published)).toBeUndefined();
  });

  test("concurrent duplicate slug is rejected", async () => {
    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    const msg1 = makeBusMsg({ slug: "concurrent", title: "C", github: "o/r" }, "reply1");
    const msg2 = makeBusMsg({ slug: "concurrent", title: "C", github: "o/r" }, "reply2");

    bus.publish("message.inbound.onboard", msg1);
    bus.publish("message.inbound.onboard", msg2);
    await new Promise(r => setTimeout(r, 200));

    const reply2 = findReply(published, "reply2");
    expect(reply2?.success).toBe(false);
    expect(String(reply2?.error)).toContain("already in progress");
  });
});

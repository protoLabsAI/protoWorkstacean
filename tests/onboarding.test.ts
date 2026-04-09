/**
 * Unit tests for OnboardingPlugin — all 9 steps.
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

let mockCreateProject: ReturnType<typeof mock>;
let mockRegisterWebhook: ReturnType<typeof mock>;
let mockListWebhooks: ReturnType<typeof mock>;
let mockListProjects: ReturnType<typeof mock>;
let mockMakeGitHubAuth: ReturnType<typeof mock>;
let mockCreateDriveFolder: ReturnType<typeof mock>;
let mockValidateProjectEntry: ReturnType<typeof mock>;

// Placeholder refs — replaced in beforeEach via closure capture
const _mocks = {
  createProject: null as unknown,
  registerWebhook: null as unknown,
  listWebhooks: null as unknown,
  listProjects: null as unknown,
  makeGitHubAuth: null as unknown,
  createDriveFolder: null as unknown,
  validateProjectEntry: null as unknown,
};

mock.module("../lib/plane-client.ts", () => {
  const PlaneClient = class {
    createProject(...args: unknown[]) { return (_mocks.createProject as (...a: unknown[]) => unknown)(...args); }
    registerWebhook(...args: unknown[]) { return (_mocks.registerWebhook as (...a: unknown[]) => unknown)(...args); }
    listWebhooks(...args: unknown[]) { return (_mocks.listWebhooks as (...a: unknown[]) => unknown)(...args); }
    listProjects(...args: unknown[]) { return (_mocks.listProjects as (...a: unknown[]) => unknown)(...args); }
    fetchLabels() { return Promise.resolve(new Map()); }
    fetchStates() { return Promise.resolve(new Map()); }
    hasLabel() { return Promise.resolve(false); }
    invalidate() {}
    patchIssueState() { return Promise.resolve(true); }
    addIssueComment() { return Promise.resolve(true); }
  };
  return { PlaneClient };
});

mock.module("../lib/github-auth.ts", () => ({
  makeGitHubAuth: (...args: unknown[]) => (_mocks.makeGitHubAuth as (...a: unknown[]) => unknown)(...args),
}));

mock.module("../lib/plugins/google.ts", () => ({
  createDriveFolder: (...args: unknown[]) => (_mocks.createDriveFolder as (...a: unknown[]) => unknown)(...args),
  getGoogleAccessToken: () => Promise.resolve(null),
  GooglePlugin: class {},
}));

mock.module("../lib/project-schema.ts", () => ({
  validateProjectEntry: (...args: unknown[]) => (_mocks.validateProjectEntry as (...a: unknown[]) => unknown)(...args),
  parseProjectsYaml: () => ({ projects: [] }),
}));

// Import the plugin AFTER mock.module calls
const { OnboardingPlugin } = await import("../lib/plugins/onboarding.ts");

// ── Default env setup ─────────────────────────────────────────────────────────

const DEFAULT_ENV: Record<string, string> = {
  PLANE_API_KEY: "test-plane-key",
  PLANE_BASE_URL: "http://localhost:3002",
  PLANE_WORKSPACE_SLUG: "testws",
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
    _mocks.createProject = mock(() => Promise.resolve({ id: "proj-1", name: "Test", identifier: "TEST" }));
    _mocks.registerWebhook = mock(() => Promise.resolve(true));
    _mocks.listWebhooks = mock(() => Promise.resolve([]));
    _mocks.listProjects = mock(() => Promise.resolve([]));
    _mocks.makeGitHubAuth = mock(() => () => Promise.resolve("ghp_test"));
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
    _mocks.validateProjectEntry = mock(() => ({ ok: true, errors: [] }));
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
    await new Promise(r => setTimeout(r, 2000)); // full 9-step pipeline; generous for Docker

    const reply = findReply(published);
    expect(reply?.success).toBe(true);
  });
});

describe("OnboardingPlugin — Step 2: idempotency", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    setEnv();
    _mocks.createProject = mock(() => Promise.resolve({ id: "proj-1", name: "Test", identifier: "TEST" }));
    _mocks.registerWebhook = mock(() => Promise.resolve(true));
    _mocks.listWebhooks = mock(() => Promise.resolve([]));
    _mocks.listProjects = mock(() => Promise.resolve([]));
    _mocks.makeGitHubAuth = mock(() => () => Promise.resolve("ghp_test"));
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
    _mocks.validateProjectEntry = mock(() => ({ ok: true, errors: [] }));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    clearEnv();
  });

  test("skips pipeline if slug already in projects.yaml", async () => {
    // Pre-write the projects.yaml with the slug
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
    await new Promise(r => setTimeout(r, 2000)); // full 9-step pipeline; generous for Docker

    const reply = findReply(published);
    expect(reply?.success).toBe(true);
    expect(reply?.status).toBe("onboarded");
  });
});

describe("OnboardingPlugin — Step 3: Plane project", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    _mocks.registerWebhook = mock(() => Promise.resolve(true));
    _mocks.listWebhooks = mock(() => Promise.resolve([]));
    _mocks.listProjects = mock(() => Promise.resolve([]));
    _mocks.makeGitHubAuth = mock(() => null); // no GitHub auth
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
    _mocks.validateProjectEntry = mock(() => ({ ok: true, errors: [] }));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    clearEnv();
  });

  test("skips when PLANE_API_KEY not set", async () => {
    setEnv({ PLANE_API_KEY: undefined, WORKSTACEAN_PUBLIC_URL: undefined });
    _mocks.createProject = mock(() => Promise.resolve(null));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p1", title: "P1", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const reply = findReply(published);
    expect(reply?.success).toBe(true);
    // planeProject should be skip
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.planeProject).toBe("skip");
  });

  test("success — creates Plane project and stores projectId", async () => {
    setEnv();
    _mocks.createProject = mock(() =>
      Promise.resolve({ id: "plane-proj-123", name: "P1", identifier: "P1" })
    );

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p1", title: "P1", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const complete = findComplete(published);
    const payload = complete?.payload as Record<string, unknown> | undefined;
    expect(payload?.planeProjectId).toBe("plane-proj-123");

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.planeProject).toBe("ok");
  });

  test("already-exists — idempotent (createProject returns existing)", async () => {
    setEnv();
    // createProject in PlaneClient returns existing project if identifier taken
    _mocks.createProject = mock(() =>
      Promise.resolve({ id: "existing-plane-id", name: "P1", identifier: "P1" })
    );

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p1", title: "P1", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const complete = findComplete(published);
    const payload = complete?.payload as Record<string, unknown> | undefined;
    expect(payload?.planeProjectId).toBe("existing-plane-id");
  });

  test("API error — step returns error but pipeline continues", async () => {
    setEnv();
    _mocks.createProject = mock(() => Promise.reject(new Error("Plane API down")));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p1", title: "P1", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    // Pipeline continues even with error
    expect(steps?.planeProject).toBe("error");
    expect(steps?.projectsYaml).toBeDefined();
  });
});

describe("OnboardingPlugin — Step 4: Plane webhook", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    _mocks.createProject = mock(() => Promise.resolve({ id: "proj-1", name: "T", identifier: "T" }));
    _mocks.listProjects = mock(() => Promise.resolve([]));
    _mocks.makeGitHubAuth = mock(() => null);
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
    _mocks.validateProjectEntry = mock(() => ({ ok: true, errors: [] }));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    clearEnv();
  });

  test("success — registers webhook", async () => {
    setEnv();
    _mocks.registerWebhook = mock(() => Promise.resolve(true));
    _mocks.listWebhooks = mock(() => Promise.resolve([]));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p2", title: "P2", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.planeWebhook).toBe("ok");
  });

  test("already-registered — skips (registerWebhook returns true on duplicate)", async () => {
    setEnv();
    // The PlaneClient.registerWebhook itself checks listWebhooks and returns true if already registered
    _mocks.listWebhooks = mock(() =>
      Promise.resolve([{ id: "wh-1", url: "https://ws.test/webhooks/plane" }])
    );
    _mocks.registerWebhook = mock(() => Promise.resolve(true));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p2", title: "P2", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(["ok", "skip"]).toContain(steps?.planeWebhook);
  });

  test("skips when WORKSTACEAN_PUBLIC_URL not set", async () => {
    setEnv({ WORKSTACEAN_PUBLIC_URL: undefined });
    _mocks.registerWebhook = mock(() => Promise.resolve(true));
    _mocks.listWebhooks = mock(() => Promise.resolve([]));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p2", title: "P2", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.planeWebhook).toBe("skip");
  });
});

describe("OnboardingPlugin — Step 5: GitHub webhook", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    setEnv();
    _mocks.createProject = mock(() => Promise.resolve({ id: "proj-1", name: "T", identifier: "T" }));
    _mocks.registerWebhook = mock(() => Promise.resolve(true));
    _mocks.listWebhooks = mock(() => Promise.resolve([]));
    _mocks.listProjects = mock(() => Promise.resolve([]));
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
    _mocks.validateProjectEntry = mock(() => ({ ok: true, errors: [] }));
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

    // Override global fetch for this test
    const origFetch = global.fetch;
    global.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/repos/owner/repo/hooks")) {
        if (!init?.method || init.method === "GET") {
          // list — return empty (no existing webhooks)
          return new Response(JSON.stringify([]), { status: 200 });
        } else {
          // POST create
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

    // list returns [] on 401 (listGitHubWebhooks returns [] on !resp.ok)
    // so it tries to create and createGitHubWebhook returns false → error
    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.githubWebhook).toBe("error");
  });
});

describe("OnboardingPlugin — Step 6: Drive folder", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    setEnv();
    _mocks.createProject = mock(() => Promise.resolve({ id: "proj-1", name: "T", identifier: "T" }));
    _mocks.registerWebhook = mock(() => Promise.resolve(true));
    _mocks.listWebhooks = mock(() => Promise.resolve([]));
    _mocks.listProjects = mock(() => Promise.resolve([]));
    _mocks.makeGitHubAuth = mock(() => null);
    _mocks.validateProjectEntry = mock(() => ({ ok: true, errors: [] }));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    clearEnv();
  });

  test("skips when Google credentials not set", async () => {
    // No GOOGLE_* env vars
    _mocks.createDriveFolder = mock(() => Promise.resolve({ id: "folder-id", name: "T" }));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p6", title: "P6", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.driveFolder).toBe("skip");
    // createDriveFolder should NOT have been called
    expect((_mocks.createDriveFolder as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("skips when google.yaml has no orgFolderId", async () => {
    setEnv({
      GOOGLE_CLIENT_ID: "gc-id",
      GOOGLE_CLIENT_SECRET: "gc-secret",
      GOOGLE_REFRESH_TOKEN: "gc-refresh",
    });
    // Write google.yaml without orgFolderId
    writeFileSync(join(workspaceDir, "google.yaml"), `drive:\n  orgFolderId: ""\n`, "utf8");
    _mocks.createDriveFolder = mock(() => Promise.resolve({ id: "folder-id", name: "T" }));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p6", title: "P6", github: "o/r" }));
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
    _mocks.createDriveFolder = mock(() => Promise.resolve({ id: "new-folder-id", name: "P6" }));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p6", title: "P6", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const reply = findReply(published);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.driveFolder).toBe("ok");

    const complete = findComplete(published);
    const payload = complete?.payload as Record<string, unknown> | undefined;
    expect(payload?.driveFolderId).toBe("new-folder-id");
  });
});

describe("OnboardingPlugin — Step 7: projects.yaml write", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    setEnv({ PLANE_API_KEY: undefined, WORKSTACEAN_PUBLIC_URL: undefined });
    _mocks.createProject = mock(() => Promise.resolve(null));
    _mocks.registerWebhook = mock(() => Promise.resolve(true));
    _mocks.listWebhooks = mock(() => Promise.resolve([]));
    _mocks.listProjects = mock(() => Promise.resolve([]));
    _mocks.makeGitHubAuth = mock(() => null);
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
    _mocks.validateProjectEntry = mock(() => ({ ok: true, errors: [] }));
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
    // Both entries present
    expect(parsed.projects.some(p => p.slug === "existing-proj")).toBe(true);
    expect(parsed.projects.some(p => p.slug === "another-proj")).toBe(true);
    // Exactly once
    expect(parsed.projects.filter(p => p.slug === "another-proj").length).toBe(1);
  });

  test("includes planeProjectId when Plane step succeeded", async () => {
    setEnv(); // with PLANE_API_KEY
    _mocks.createProject = mock(() => Promise.resolve({ id: "plane-id-789", name: "T", identifier: "T" }));
    _mocks.registerWebhook = mock(() => Promise.resolve(true));
    _mocks.listWebhooks = mock(() => Promise.resolve([]));
    _mocks.listProjects = mock(() => Promise.resolve([]));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p7", title: "P7", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const projectsPath = join(workspaceDir, "projects.yaml");
    const content = readFileSync(projectsPath, "utf8");
    const parsed = parseYaml(content) as { projects: { slug: string; planeProjectId?: string }[] };
    const entry = parsed.projects.find(p => p.slug === "p7");
    expect(entry?.planeProjectId).toBe("plane-id-789");
  });

  test("includes driveFolderId when Drive step succeeded", async () => {
    setEnv({
      GOOGLE_CLIENT_ID: "gc-id",
      GOOGLE_CLIENT_SECRET: "gc-secret",
      GOOGLE_REFRESH_TOKEN: "gc-refresh",
    });
    writeFileSync(join(workspaceDir, "google.yaml"), `drive:\n  orgFolderId: "root-id"\n`, "utf8");
    _mocks.createDriveFolder = mock(() => Promise.resolve({ id: "drive-folder-456", name: "P7" }));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "p7b", title: "P7B", github: "o/r" }));
    await new Promise(r => setTimeout(r, 100));

    const projectsPath = join(workspaceDir, "projects.yaml");
    const content = readFileSync(projectsPath, "utf8");
    const parsed = parseYaml(content) as {
      projects: { slug: string; googleWorkspace?: { driveFolderId?: string } }[];
    };
    const entry = parsed.projects.find(p => p.slug === "p7b");
    expect(entry?.googleWorkspace?.driveFolderId).toBe("drive-folder-456");
  });
});

describe("OnboardingPlugin — Full pipeline", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "onboard-test-"));
    setEnv();
    _mocks.createProject = mock(() => Promise.resolve({ id: "plane-p", name: "Full", identifier: "FULL" }));
    _mocks.registerWebhook = mock(() => Promise.resolve(true));
    _mocks.listWebhooks = mock(() => Promise.resolve([]));
    _mocks.listProjects = mock(() => Promise.resolve([]));
    _mocks.makeGitHubAuth = mock(() => null);
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
    _mocks.validateProjectEntry = mock(() => ({ ok: true, errors: [] }));
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

    // Complete event published
    const complete = findComplete(published);
    expect(complete).toBeDefined();

    // Reply with success
    const reply = findReply(published);
    expect(reply?.success).toBe(true);
    expect(reply?.step).toBe("complete");
    expect(reply?.slug).toBe("full-pipeline");

    // Steps summary present
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.planeProject).toBeDefined();
    expect(steps?.planeWebhook).toBeDefined();
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
    setEnv({ PLANE_API_KEY: undefined, WORKSTACEAN_PUBLIC_URL: undefined });
    _mocks.createProject = mock(() => Promise.resolve(null));
    _mocks.registerWebhook = mock(() => Promise.resolve(true));
    _mocks.listWebhooks = mock(() => Promise.resolve([]));
    _mocks.listProjects = mock(() => Promise.resolve([]));
    _mocks.makeGitHubAuth = mock(() => null);
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
    _mocks.validateProjectEntry = mock(() => ({ ok: true, errors: [] }));
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
    // Exactly one entry
    expect(parsed.projects.filter(p => p.slug === "idem-proj").length).toBe(1);

    // Second reply is already_onboarded
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
    _mocks.registerWebhook = mock(() => Promise.resolve(true));
    _mocks.listWebhooks = mock(() => Promise.resolve([]));
    _mocks.listProjects = mock(() => Promise.resolve([]));
    _mocks.makeGitHubAuth = mock(() => null);
    _mocks.createDriveFolder = mock(() => Promise.resolve(null));
    _mocks.validateProjectEntry = mock(() => ({ ok: true, errors: [] }));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    clearEnv();
  });

  test("non-fatal step error (Plane) does not abort pipeline", async () => {
    _mocks.createProject = mock(() => Promise.reject(new Error("Plane down")));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "err-test", title: "Err", github: "o/r" }));
    await new Promise(r => setTimeout(r, 150));

    const reply = findReply(published);
    // Pipeline continues — projects.yaml still written
    expect(reply?.success).toBe(true);
    const steps = reply?.steps as Record<string, string> | undefined;
    expect(steps?.planeProject).toBe("error");
    expect(steps?.projectsYaml).toBe("ok");
  });

  test("fatal step error (projects.yaml schema fail) aborts pipeline", async () => {
    _mocks.createProject = mock(() => Promise.resolve({ id: "p", name: "T", identifier: "T" }));
    // validateProjectEntry returns failure
    _mocks.validateProjectEntry = mock(() => ({ ok: false, errors: ["slug is required"] }));

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    bus.publish("message.inbound.onboard", makeBusMsg({ slug: "fatal-test", title: "Fatal", github: "o/r" }));
    await new Promise(r => setTimeout(r, 150));

    const reply = findReply(published);
    expect(reply?.success).toBe(false);
    expect(reply?.step).toBe("projects_yaml");
    // No complete event published
    expect(findComplete(published)).toBeUndefined();
  });

  test("concurrent duplicate slug is rejected", async () => {
    _mocks.createProject = mock(async () => {
      await new Promise(r => setTimeout(r, 50)); // slow
      return { id: "p", name: "T", identifier: "T" };
    });

    const plugin = new OnboardingPlugin(workspaceDir);
    const { bus, published } = makeTestBus();
    plugin.install(bus);

    const msg1 = makeBusMsg({ slug: "concurrent", title: "C", github: "o/r" }, "reply1");
    const msg2 = makeBusMsg({ slug: "concurrent", title: "C", github: "o/r" }, "reply2");

    bus.publish("message.inbound.onboard", msg1);
    bus.publish("message.inbound.onboard", msg2);
    await new Promise(r => setTimeout(r, 200));

    const reply2 = findReply(published, "reply2");
    // Second concurrent run should be rejected
    expect(reply2?.success).toBe(false);
    expect(String(reply2?.error)).toContain("already in progress");
  });
});

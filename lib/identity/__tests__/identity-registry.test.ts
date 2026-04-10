import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IdentityRegistry } from "../identity-registry.ts";

const TEST_DIR = join(import.meta.dir, ".test-identity-workspace");
const USERS_YAML = join(TEST_DIR, "users.yaml");

function setup(content?: string) {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  if (content !== undefined) writeFileSync(USERS_YAML, content, "utf8");
}

function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

describe("IdentityRegistry — no users.yaml", () => {
  let registry: IdentityRegistry;

  beforeEach(() => {
    setup(); // dir exists, no users.yaml
    registry = new IdentityRegistry(TEST_DIR);
  });

  afterEach(() => {
    registry.unwatch();
    cleanup();
  });

  it("resolve() returns null when no users.yaml", () => {
    expect(registry.resolve("discord", "12345")).toBeNull();
  });

  it("groupId() falls back to user:{platform}_{id} when unknown", () => {
    expect(registry.groupId("discord", "12345")).toBe("user:discord_12345");
  });

  it("memoryEnabledUsers() returns empty array", () => {
    expect(registry.memoryEnabledUsers()).toHaveLength(0);
  });
});

describe("IdentityRegistry — with users.yaml", () => {
  let registry: IdentityRegistry;

  beforeEach(() => {
    setup(`
users:
  - id: josh
    displayName: Josh
    admin: true
    memoryEnabled: true
    identities:
      discord: "111222333444555"
      github: "bioshazard"
      signal: "+15555550001"

  - id: alice
    displayName: Alice
    admin: false
    memoryEnabled: true
    identities:
      discord: "999888777666555"
      slack: "U01ABCDEF"

  - id: bot
    displayName: Automation Bot
    admin: false
    memoryEnabled: false
    identities:
      discord: "000000000000001"
`);
    registry = new IdentityRegistry(TEST_DIR);
  });

  afterEach(() => {
    registry.unwatch();
    cleanup();
  });

  it("resolve() returns correct identity for known discord user", () => {
    const user = registry.resolve("discord", "111222333444555");
    expect(user).not.toBeNull();
    expect(user!.id).toBe("josh");
    expect(user!.displayName).toBe("Josh");
  });

  it("resolve() returns correct identity for github lookup", () => {
    const user = registry.resolve("github", "bioshazard");
    expect(user).not.toBeNull();
    expect(user!.id).toBe("josh");
  });

  it("resolve() returns null for unknown ID", () => {
    expect(registry.resolve("discord", "000000000099999")).toBeNull();
  });

  it("resolve() returns null for unknown platform", () => {
    expect(registry.resolve("telegram", "111222333444555")).toBeNull();
  });

  it("groupId() returns user:{id} for known user", () => {
    expect(registry.groupId("discord", "111222333444555")).toBe("user:josh");
    expect(registry.groupId("github", "bioshazard")).toBe("user:josh");
  });

  it("groupId() falls back to user:{platform}_{id} for unknown user", () => {
    expect(registry.groupId("discord", "unknown999")).toBe("user:discord_unknown999");
  });

  it("adminIds() returns admin platform IDs for given platform", () => {
    const admins = registry.adminIds("discord");
    expect(admins).toContain("111222333444555");
    expect(admins).not.toContain("999888777666555"); // alice is not admin
  });

  it("adminIds() includes all platforms the admin user has", () => {
    // josh is admin and has discord + github + signal
    const signalAdmins = registry.adminIds("signal");
    expect(signalAdmins).toContain("+15555550001");
  });

  it("adminIds() returns empty array for platform no admin has", () => {
    // no admin user has a slack identity
    expect(registry.adminIds("slack")).toHaveLength(0);
  });

  it("memoryEnabledUsers() returns only users with memoryEnabled: true", () => {
    const enabled = registry.memoryEnabledUsers();
    const ids = enabled.map(u => u.id);
    expect(ids).toContain("josh");
    expect(ids).toContain("alice");
    expect(ids).not.toContain("bot");
  });

  it("platformIds() returns all platform identities for a canonical ID", () => {
    const ids = registry.platformIds("josh");
    expect(ids.discord).toBe("111222333444555");
    expect(ids.github).toBe("bioshazard");
    expect(ids.signal).toBe("+15555550001");
  });

  it("platformIds() returns empty object for unknown canonical ID", () => {
    const ids = registry.platformIds("nobody");
    expect(Object.keys(ids)).toHaveLength(0);
  });
});

describe("IdentityRegistry — slack lookup", () => {
  let registry: IdentityRegistry;

  beforeEach(() => {
    setup(`
users:
  - id: alice
    displayName: Alice
    memoryEnabled: true
    identities:
      discord: "999888777666555"
      slack: "U01ABCDEF"
`);
    registry = new IdentityRegistry(TEST_DIR);
  });

  afterEach(() => {
    registry.unwatch();
    cleanup();
  });

  it("resolves slack member ID", () => {
    const user = registry.resolve("slack", "U01ABCDEF");
    expect(user?.id).toBe("alice");
  });

  it("groupId for slack user returns user:alice", () => {
    expect(registry.groupId("slack", "U01ABCDEF")).toBe("user:alice");
  });
});

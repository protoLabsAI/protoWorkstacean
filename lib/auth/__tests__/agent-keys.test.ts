/**
 * Unit tests for AgentKeyRegistry — the per-agent X-API-Key resolver.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentKeyRegistry } from "../agent-keys.ts";

let workspace: string;
const ENV_KEYS = ["WORKSTACEAN_API_KEY_QUINN", "WORKSTACEAN_API_KEY_AVA", "WORKSTACEAN_API_KEY_JON"];

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "agent-keys-test-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  for (const k of ENV_KEYS) delete process.env[k];
});

function writeYaml(content: string): void {
  writeFileSync(join(workspace, "agent-keys.yaml"), content);
}

describe("AgentKeyRegistry.resolve", () => {
  test("admin key returns isAdmin true with no agentName", () => {
    const reg = new AgentKeyRegistry(workspace, "admin-secret");
    expect(reg.resolve("admin-secret")).toEqual({ isAdmin: true });
  });

  test("agent-scoped key returns the right agentName", () => {
    process.env.WORKSTACEAN_API_KEY_QUINN = "quinn-secret-xyz";
    writeYaml("keys:\n  quinn:\n    envKey: WORKSTACEAN_API_KEY_QUINN");
    const reg = new AgentKeyRegistry(workspace, "admin-secret");
    expect(reg.resolve("quinn-secret-xyz")).toEqual({ agentName: "quinn", isAdmin: false });
  });

  test("unknown key returns null", () => {
    const reg = new AgentKeyRegistry(workspace, "admin-secret");
    expect(reg.resolve("not-a-real-key")).toBeNull();
  });

  test("missing key returns null", () => {
    const reg = new AgentKeyRegistry(workspace, "admin-secret");
    expect(reg.resolve(null)).toBeNull();
    expect(reg.resolve(undefined)).toBeNull();
    expect(reg.resolve("")).toBeNull();
  });

  test("admin always wins over agent — same key value would be admin-resolved", () => {
    // Edge case: env var is set to the same value as the admin key. Admin
    // path is checked first so the caller is treated as admin.
    process.env.WORKSTACEAN_API_KEY_QUINN = "shared-key";
    writeYaml("keys:\n  quinn:\n    envKey: WORKSTACEAN_API_KEY_QUINN");
    const reg = new AgentKeyRegistry(workspace, "shared-key");
    expect(reg.resolve("shared-key")).toEqual({ isAdmin: true });
  });

  test("missing yaml file → no agent keys, admin still works", () => {
    const reg = new AgentKeyRegistry(workspace, "admin-secret");
    expect(reg.hasAgentKeys).toBe(false);
    expect(reg.agentNames()).toEqual([]);
    expect(reg.resolve("admin-secret")).toEqual({ isAdmin: true });
  });

  test("yaml entry whose envKey is unset is silently skipped", () => {
    writeYaml("keys:\n  quinn:\n    envKey: WORKSTACEAN_API_KEY_QUINN_NOT_SET");
    const reg = new AgentKeyRegistry(workspace, "admin-secret");
    expect(reg.hasAgentKeys).toBe(false);
  });

  test("multiple agents from one yaml", () => {
    process.env.WORKSTACEAN_API_KEY_QUINN = "quinn-key";
    process.env.WORKSTACEAN_API_KEY_AVA = "ava-key";
    process.env.WORKSTACEAN_API_KEY_JON = "jon-key";
    writeYaml(`keys:
  quinn:
    envKey: WORKSTACEAN_API_KEY_QUINN
  ava:
    envKey: WORKSTACEAN_API_KEY_AVA
  jon:
    envKey: WORKSTACEAN_API_KEY_JON`);
    const reg = new AgentKeyRegistry(workspace, "admin-secret");
    expect(reg.hasAgentKeys).toBe(true);
    expect(reg.agentNames().sort()).toEqual(["ava", "jon", "quinn"]);
    expect(reg.resolve("quinn-key")?.agentName).toBe("quinn");
    expect(reg.resolve("ava-key")?.agentName).toBe("ava");
    expect(reg.resolve("jon-key")?.agentName).toBe("jon");
  });

  test("admin key undefined — admin path disabled but agents still work", () => {
    process.env.WORKSTACEAN_API_KEY_QUINN = "quinn-key";
    writeYaml("keys:\n  quinn:\n    envKey: WORKSTACEAN_API_KEY_QUINN");
    const reg = new AgentKeyRegistry(workspace, undefined);
    expect(reg.resolve("any-admin-attempt")).toBeNull();
    expect(reg.resolve("quinn-key")?.agentName).toBe("quinn");
  });

  test("malformed yaml is logged + treated as no-keys (graceful degradation)", () => {
    writeYaml("not: valid: yaml: structure: ::");
    const reg = new AgentKeyRegistry(workspace, "admin-secret");
    expect(reg.hasAgentKeys).toBe(false);
    expect(reg.resolve("admin-secret")).toEqual({ isAdmin: true });
  });
});

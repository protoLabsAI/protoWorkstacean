/**
 * MCP config resolution + the trust/filter gates (ADR-0005 P4). Pure, plus one
 * bounded probe against a non-existent command to exercise the reachable:false
 * path without a real MCP server.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { resolveServerConfig, mcpEnabled, toolAllowed, probeMcpServer } from "../mcp-connect.ts";
import { mcpSkillName } from "../mcp-client-plugin.ts";
import type { McpServerDef } from "../types.ts";

describe("mcpEnabled (trust-tier gate, ADR-0005 D2)", () => {
  test("explicit enabled wins over trust", () => {
    expect(mcpEnabled({ trust: "community", enabled: true })).toBe(true);
    expect(mcpEnabled({ trust: "builtin", enabled: false })).toBe(false);
  });
  test("builtin/trusted auto-enable; community (and default) off", () => {
    expect(mcpEnabled({ trust: "builtin" })).toBe(true);
    expect(mcpEnabled({ trust: "trusted" })).toBe(true);
    expect(mcpEnabled({ trust: "community" })).toBe(false);
    expect(mcpEnabled({})).toBe(false);
  });
});

describe("resolveServerConfig", () => {
  test("applies defaults (community/stdio), grants→[], enabled from trust", () => {
    const cfg = resolveServerConfig({ name: "x", command: ["server"] });
    expect(cfg.trust).toBe("community");
    expect(cfg.transport).toBe("stdio");
    expect(cfg.grants).toEqual([]);
    expect(cfg.enabled).toBe(false); // community default
  });
  test("merges command + args into one argv (command[0] is the executable)", () => {
    const cfg = resolveServerConfig({ name: "x", command: ["npx"], args: ["-y", "pkg", "/data"] });
    expect(cfg.command).toEqual(["npx", "-y", "pkg", "/data"]);
  });
  test("interpolates ${ENV} in env values and url", () => {
    process.env.MCP_TEST_TOKEN = "sekret";
    try {
      const cfg = resolveServerConfig({
        name: "x", trust: "trusted", transport: "sse",
        url: "https://host/${MCP_TEST_TOKEN}", env: { TOKEN: "${MCP_TEST_TOKEN}" },
      });
      expect(cfg.url).toBe("https://host/sekret");
      expect(cfg.env).toEqual({ TOKEN: "sekret" });
      expect(cfg.enabled).toBe(true); // trusted
    } finally {
      delete process.env.MCP_TEST_TOKEN;
    }
  });
});

describe("toolAllowed (allow/exclude filter, exclude wins)", () => {
  const cfg = resolveServerConfig({ name: "x", command: ["s"], allowedTools: ["read", "write"], excludeTools: ["write"] });
  test("allowed when in allowlist and not excluded", () => {
    expect(toolAllowed(cfg, "read")).toBe(true);
  });
  test("excluded beats allowed", () => {
    expect(toolAllowed(cfg, "write")).toBe(false);
  });
  test("not in allowlist → denied", () => {
    expect(toolAllowed(cfg, "delete")).toBe(false);
  });
  test("no allowlist → everything not-excluded is allowed", () => {
    const open = resolveServerConfig({ name: "y", command: ["s"], excludeTools: ["danger"] });
    expect(toolAllowed(open, "anything")).toBe(true);
    expect(toolAllowed(open, "danger")).toBe(false);
  });
});

describe("mcpSkillName", () => {
  test("namespaces the tool by server to avoid collisions", () => {
    expect(mcpSkillName("filesystem", "read_file")).toBe("filesystem.read_file");
  });
});

describe("probeMcpServer", () => {
  afterEach(() => {});
  test("a non-existent stdio command → reachable:false (never throws)", async () => {
    const def: McpServerDef = { name: "ghost", transport: "stdio", command: ["this-command-does-not-exist-pw4231"] };
    const result = await probeMcpServer(def);
    expect(result.reachable).toBe(false);
    expect(result.name).toBe("ghost");
    expect(typeof result.error).toBe("string");
  }, 12_000);
});

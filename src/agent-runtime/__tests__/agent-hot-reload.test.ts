/**
 * AgentRuntimePlugin hot-reload apply (ADR-0004 P1, day 2): reconcile the live
 * ExecutorRegistry against workspace/agents/ on change — add / reload / remove,
 * with the parse-error-keeps-running safety guard. Drives the apply directly
 * with an injected fake executor factory + a real ExecutorRegistry + a temp dir.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimePlugin } from "../agent-runtime-plugin.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import type { IExecutor } from "../../executor/types.ts";
import type { AgentDefinition } from "../types.ts";
import type { EventBus } from "../../../lib/types.ts";

const FAKE_BUS = { subscribe: () => "s", unsubscribe: () => {}, publish: () => {} } as unknown as EventBus;

function agentYaml(name: string, skills: string[], model = "m"): string {
  const skillBlock = skills.map((s) => `  - name: ${s}\n    description: ${s} skill\n    keywords: []`).join("\n");
  return `name: ${name}\nrole: general\nmodel: ${model}\nsystemPrompt: hi\nskills:\n${skillBlock}\n`;
}

/** (skill@agentName) pairs currently registered. */
function pairs(reg: ExecutorRegistry): string[] {
  return reg.list().map((r) => `${r.skill}@${r.agentName}`).sort();
}

describe("AgentRuntimePlugin hot-reload apply", () => {
  let root: string;
  let agentsDir: string;
  let registry: ExecutorRegistry;
  let plugin: AgentRuntimePlugin;
  let disposed: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agents-"));
    agentsDir = join(root, "agents");
    mkdirSync(agentsDir);
    registry = new ExecutorRegistry();
    disposed = [];
    const buildExecutor = (def: AgentDefinition): IExecutor => ({
      type: "fake",
      execute: async () => ({ text: "", isError: false, correlationId: "" }),
      dispose: () => { disposed.push(def.name); },
    });
    plugin = new AgentRuntimePlugin({ workspaceDir: root }, registry, { buildExecutor });
  });

  afterEach(() => {
    plugin.uninstall();
    rmSync(root, { recursive: true, force: true });
  });

  async function apply(): Promise<void> {
    (plugin as unknown as { _applyAgentChanges: () => void })._applyAgentChanges();
    // Executor disposal is best-effort/deferred (a microtask, so it never blocks
    // the apply); flush it before asserting on `disposed`.
    await new Promise((r) => setTimeout(r, 0));
  }

  test("install registers the agents present at boot", () => {
    writeFileSync(join(agentsDir, "ava.yaml"), agentYaml("ava", ["chat"]));
    plugin.install(FAKE_BUS);
    expect(pairs(registry)).toEqual(["chat@ava"]);
  });

  test("add: a new agent file is registered with no restart", async () => {
    writeFileSync(join(agentsDir, "ava.yaml"), agentYaml("ava", ["chat"]));
    plugin.install(FAKE_BUS);

    writeFileSync(join(agentsDir, "quinn.yaml"), agentYaml("quinn", ["review"]));
    await apply();
    expect(pairs(registry)).toEqual(["chat@ava", "review@quinn"]);
  });

  test("change: skills re-registered (dropped skill removed, new skill added), old executor disposed", async () => {
    writeFileSync(join(agentsDir, "ava.yaml"), agentYaml("ava", ["chat"]));
    plugin.install(FAKE_BUS);

    // ava now serves "triage" instead of "chat"
    writeFileSync(join(agentsDir, "ava.yaml"), agentYaml("ava", ["triage"]));
    await apply();
    expect(pairs(registry)).toEqual(["triage@ava"]); // chat gone, triage added, no dup
    expect(disposed).toContain("ava"); // old executor torn down
  });

  test("remove: deleting the file unregisters the agent + disposes it", async () => {
    writeFileSync(join(agentsDir, "ava.yaml"), agentYaml("ava", ["chat"]));
    writeFileSync(join(agentsDir, "quinn.yaml"), agentYaml("quinn", ["review"]));
    plugin.install(FAKE_BUS);
    expect(pairs(registry)).toEqual(["chat@ava", "review@quinn"]);

    unlinkSync(join(agentsDir, "quinn.yaml"));
    await apply();
    expect(pairs(registry)).toEqual(["chat@ava"]);
    expect(disposed).toContain("quinn");
  });

  test("parse error keeps the running agent (a typo never drops a live agent)", async () => {
    writeFileSync(join(agentsDir, "ava.yaml"), agentYaml("ava", ["chat"]));
    plugin.install(FAKE_BUS);

    // Corrupt the file (missing required `model`) — it no longer parses to "ava",
    // but the file still EXISTS, so the running instance must be kept.
    writeFileSync(join(agentsDir, "ava.yaml"), "name: ava\nrole: general\nsystemPrompt: hi\nskills: []\n");
    await apply();
    expect(pairs(registry)).toEqual(["chat@ava"]); // still registered
    expect(disposed).not.toContain("ava");
  });
});

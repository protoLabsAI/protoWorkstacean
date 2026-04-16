import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEventBus } from "../../bus.ts";
import { ConfigChangeHITLPlugin, recordPendingContent } from "../config-change-hitl.ts";
import type { ConfigChangeRequest } from "../../types.ts";

describe("ConfigChangeHITLPlugin — applier", () => {
  let workspaceDir: string;
  let bus: InMemoryEventBus;
  let plugin: ConfigChangeHITLPlugin;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "cchitl-"));
    mkdirSync(join(workspaceDir, "agents"), { recursive: true });
    bus = new InMemoryEventBus();
    plugin = new ConfigChangeHITLPlugin();
    plugin.setWorkspaceDir(workspaceDir);
    plugin.install(bus);
  });

  afterEach(() => {
    plugin.uninstall();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function publishRequest(req: ConfigChangeRequest): void {
    bus.publish(`config.change.request.${req.correlationId}`, {
      id: crypto.randomUUID(),
      correlationId: req.correlationId,
      topic: `config.change.request.${req.correlationId}`,
      timestamp: Date.now(),
      payload: req,
    });
  }

  function publishApproval(correlationId: string, decision: "approve" | "reject"): void {
    bus.publish(`config.change.response.${correlationId}`, {
      id: crypto.randomUUID(),
      correlationId,
      topic: `config.change.response.${correlationId}`,
      timestamp: Date.now(),
      payload: { type: "config_change_response", correlationId, decision, decidedBy: "test" },
    });
  }

  test("writes agent YAML on approve", async () => {
    const target = join(workspaceDir, "agents", "demo.yaml");
    writeFileSync(target, "name: demo\nsystemPrompt: original\n");

    const correlationId = "c1";
    const newContent = "name: demo\nsystemPrompt: updated\n";
    recordPendingContent(correlationId, target, newContent);

    publishRequest({
      type: "config_change_request",
      correlationId,
      configFile: { type: "agent", agentName: "demo" },
      title: "Update demo prompt",
      summary: "Test apply",
      yamlDiff: "- original\n+ updated\n",
      evidence: { sampleCount: 60, baselineMetric: "successRate=0.45", proposedDelta: "+0.2", affectedSkills: ["chat"] },
      options: ["approve", "reject"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      replyTopic: `config.change.response.${correlationId}`,
    });

    publishApproval(correlationId, "approve");
    await new Promise(r => setTimeout(r, 20));

    expect(readFileSync(target, "utf8")).toBe(newContent);
  });

  test("does NOT write on reject", async () => {
    const target = join(workspaceDir, "agents", "demo.yaml");
    const originalContent = "name: demo\nsystemPrompt: original\n";
    writeFileSync(target, originalContent);

    const correlationId = "c2";
    recordPendingContent(correlationId, target, "updated");

    publishRequest({
      type: "config_change_request",
      correlationId,
      configFile: { type: "agent", agentName: "demo" },
      title: "t", summary: "s", yamlDiff: "d",
      evidence: { sampleCount: 100, baselineMetric: "b", proposedDelta: "d", affectedSkills: ["x"] },
      options: ["approve", "reject"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      replyTopic: `config.change.response.${correlationId}`,
    });

    publishApproval(correlationId, "reject");
    await new Promise(r => setTimeout(r, 20));

    expect(readFileSync(target, "utf8")).toBe(originalContent);
  });

  test("does not write when target file does not exist (no create-via-approval)", async () => {
    const correlationId = "c3";
    const target = join(workspaceDir, "agents", "missing.yaml");
    recordPendingContent(correlationId, target, "name: missing\n");

    publishRequest({
      type: "config_change_request",
      correlationId,
      configFile: { type: "agent", agentName: "missing" },
      title: "t", summary: "s", yamlDiff: "d",
      evidence: { sampleCount: 100, baselineMetric: "b", proposedDelta: "d", affectedSkills: ["x"] },
      options: ["approve", "reject"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      replyTopic: `config.change.response.${correlationId}`,
    });

    publishApproval(correlationId, "approve");
    await new Promise(r => setTimeout(r, 20));

    // File still doesn't exist — applier refuses to create new files
    expect(() => readFileSync(target, "utf8")).toThrow();
  });

  test("publishes config.change.applied.* on successful apply", async () => {
    const target = join(workspaceDir, "goals.yaml");
    writeFileSync(target, "goals: []\n");

    const correlationId = "c4";
    recordPendingContent(correlationId, target, "goals: [updated]\n");

    const appliedEvents: unknown[] = [];
    bus.subscribe("config.change.applied.#", "test-sub", msg => {
      appliedEvents.push(msg.payload);
    });

    publishRequest({
      type: "config_change_request",
      correlationId,
      configFile: "goals.yaml",
      title: "t", summary: "s", yamlDiff: "d",
      options: ["approve", "reject"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      replyTopic: `config.change.response.${correlationId}`,
    });

    publishApproval(correlationId, "approve");
    await new Promise(r => setTimeout(r, 20));

    expect(appliedEvents).toHaveLength(1);
    expect((appliedEvents[0] as { type: string }).type).toBe("config_change_applied");
  });
});

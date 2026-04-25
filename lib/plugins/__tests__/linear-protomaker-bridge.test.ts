/**
 * LinearProtoMakerBridge tests — verify label gating, mapping resolution,
 * and the shape of the dispatched manage_feature request. The plugin
 * itself doesn't reach Linear or protoMaker; everything goes through the
 * bus.
 *
 * We construct mappings via a temp workspace directory rather than
 * exposing the loader, so the tests exercise the same yaml-parse path
 * production uses.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryEventBus } from "../../bus.ts";
import { LinearProtoMakerBridgePlugin } from "../linear-protomaker-bridge.ts";
import type { BusMessage } from "../../types.ts";

function makeIssuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issueId: "issue-uuid-1",
    identifier: "ENG-42",
    title: "Add Linear plugin",
    description: "Some details",
    priority: "high",
    teamKey: "ENG",
    labels: ["board"],
    url: "https://linear.app/foo/issue/ENG-42",
    creatorName: "Josh",
    ...overrides,
  };
}

function publishIssueCreated(bus: InMemoryEventBus, payload: Record<string, unknown>): void {
  bus.publish("message.inbound.linear.issue.created", {
    id: crypto.randomUUID(),
    correlationId: `linear-${payload.issueId}`,
    topic: "message.inbound.linear.issue.created",
    timestamp: Date.now(),
    payload,
    source: { interface: "linear" as const, channelId: payload.teamKey as string },
    reply: { topic: `linear.reply.${payload.issueId}`, format: "structured" as const },
  });
}

describe("LinearProtoMakerBridgePlugin", () => {
  let workspaceDir: string;
  let bus: InMemoryEventBus;
  let plugin: LinearProtoMakerBridgePlugin;
  let dispatched: BusMessage[];

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "linear-bridge-test-"));
    bus = new InMemoryEventBus();
    dispatched = [];
    bus.subscribe("agent.skill.request", "test-collector", (m) => { dispatched.push(m); });
  });

  afterEach(() => {
    plugin?.uninstall();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeMappings(yaml: string): void {
    writeFileSync(join(workspaceDir, "linear-board-mappings.yaml"), yaml);
  }

  function installPlugin(): void {
    plugin = new LinearProtoMakerBridgePlugin(workspaceDir);
    plugin.install(bus);
  }

  test("issue with matching team + trigger label dispatches manage_feature", () => {
    writeMappings(`
mappings:
  - linearTeamKey: ENG
    protoMakerProjectSlug: engineering
    triggerLabel: board
`);
    installPlugin();
    publishIssueCreated(bus, makeIssuePayload());

    expect(dispatched).toHaveLength(1);
    const msg = dispatched[0];
    const p = msg.payload as Record<string, unknown>;
    expect(p.skill).toBe("manage_feature");
    expect(p.targets).toEqual(["protomaker"]);
    expect(typeof p.content).toBe("string");
    expect(p.content as string).toContain("Title: Add Linear plugin");
    expect(p.content as string).toContain("project 'engineering'");
    expect(p.content as string).toContain("ENG-42");

    const meta = p.meta as Record<string, unknown>;
    expect(meta.sourceLinearIssueId).toBe("issue-uuid-1");
    expect(meta.sourceLinearIdentifier).toBe("ENG-42");
    expect(meta.protoMakerProjectSlug).toBe("engineering");
    expect(meta.via).toBe("linear-protomaker-bridge");

    // Reply routes through Linear's outbound subscriber so the operator
    // sees the filing confirmation as a Linear comment.
    expect(msg.reply?.topic).toBe("linear.reply.issue-uuid-1");
  });

  test("issue without trigger label is ignored even when team matches", () => {
    writeMappings(`
mappings:
  - linearTeamKey: ENG
    protoMakerProjectSlug: engineering
    triggerLabel: board
`);
    installPlugin();
    publishIssueCreated(bus, makeIssuePayload({ labels: ["bug", "frontend"] }));

    expect(dispatched).toHaveLength(0);
  });

  test("issue with no labels is ignored", () => {
    writeMappings(`
mappings:
  - linearTeamKey: ENG
    protoMakerProjectSlug: engineering
    triggerLabel: board
`);
    installPlugin();
    publishIssueCreated(bus, makeIssuePayload({ labels: [] }));

    expect(dispatched).toHaveLength(0);
  });

  test("issue from unmapped team is ignored", () => {
    writeMappings(`
mappings:
  - linearTeamKey: ENG
    protoMakerProjectSlug: engineering
    triggerLabel: board
`);
    installPlugin();
    publishIssueCreated(bus, makeIssuePayload({ teamKey: "OTHER" }));

    expect(dispatched).toHaveLength(0);
  });

  test("no mappings file → bridge is a silent no-op", () => {
    // Don't write any mapping file
    installPlugin();
    publishIssueCreated(bus, makeIssuePayload());

    expect(dispatched).toHaveLength(0);
  });

  test("malformed mapping entry rejects the WHOLE file (fail-loud config)", () => {
    // V2 behavior change: a typo in any one mapping now invalidates the whole
    // file rather than partially loading it. That's a clearer signal —
    // operator sees a loud schema error instead of confused silent-drop on
    // the entry they expected to fire. Per the audit's "fail loud on config" finding.
    writeMappings(`
mappings:
  - linearTeamKey: ENG
    # missing protoMakerProjectSlug + triggerLabel
  - linearTeamKey: DESIGN
    protoMakerProjectSlug: design-system
    triggerLabel: board
`);
    installPlugin();

    // Neither entry loads — the whole file failed schema validation.
    publishIssueCreated(bus, makeIssuePayload({ teamKey: "ENG" }));
    publishIssueCreated(bus, makeIssuePayload({ teamKey: "DESIGN" }));
    expect(dispatched).toHaveLength(0);
  });

  test("missing required Linear fields short-circuit (no crash, no dispatch)", () => {
    writeMappings(`
mappings:
  - linearTeamKey: ENG
    protoMakerProjectSlug: engineering
    triggerLabel: board
`);
    installPlugin();

    // No issueId
    publishIssueCreated(bus, makeIssuePayload({ issueId: undefined }));
    // No teamKey
    publishIssueCreated(bus, makeIssuePayload({ teamKey: undefined }));
    // No title
    publishIssueCreated(bus, makeIssuePayload({ title: undefined }));

    expect(dispatched).toHaveLength(0);
  });

  test("multiple mappings — each team routes to its own project", () => {
    writeMappings(`
mappings:
  - linearTeamKey: ENG
    protoMakerProjectSlug: engineering
    triggerLabel: board
  - linearTeamKey: DESIGN
    protoMakerProjectSlug: design-system
    triggerLabel: board
`);
    installPlugin();

    publishIssueCreated(bus, makeIssuePayload({ teamKey: "ENG", issueId: "i-1" }));
    publishIssueCreated(bus, makeIssuePayload({ teamKey: "DESIGN", issueId: "i-2" }));

    expect(dispatched).toHaveLength(2);
    const projects = dispatched.map(d => (d.payload as { meta: Record<string, unknown> }).meta.protoMakerProjectSlug);
    expect(projects.sort()).toEqual(["design-system", "engineering"]);
  });

  test("priority and creator pass through into the manage_feature content", () => {
    writeMappings(`
mappings:
  - linearTeamKey: ENG
    protoMakerProjectSlug: engineering
    triggerLabel: board
`);
    installPlugin();

    publishIssueCreated(bus, makeIssuePayload({
      priority: "urgent",
      creatorName: "Alice",
    }));

    expect(dispatched).toHaveLength(1);
    const content = (dispatched[0].payload as { content: string }).content;
    expect(content).toContain("Priority: urgent");
    expect(content).toContain("Filed by: Alice");
  });

  test("priority 'none' is suppressed in the content (avoids noise)", () => {
    writeMappings(`
mappings:
  - linearTeamKey: ENG
    protoMakerProjectSlug: engineering
    triggerLabel: board
`);
    installPlugin();

    publishIssueCreated(bus, makeIssuePayload({ priority: "none" }));

    expect(dispatched).toHaveLength(1);
    const content = (dispatched[0].payload as { content: string }).content;
    expect(content).not.toContain("Priority:");
  });
});

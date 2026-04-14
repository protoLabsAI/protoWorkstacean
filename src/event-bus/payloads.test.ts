import { describe, test, expect } from "bun:test";
import type {
  AgentSkillRequestPayload,
  AgentSkillResponsePayload,
  InboundMessagePayload,
  CronPayload,
  FlowItemPayload,
  IncidentReportedPayload,
  CeremonyExecutePayload,
} from "./payloads.ts";

describe("AgentSkillRequestPayload", () => {
  test("satisfies type contract with required fields only", () => {
    const payload: AgentSkillRequestPayload = {};
    expect(payload).toBeDefined();
  });

  test("satisfies type contract with all common fields", () => {
    const payload: AgentSkillRequestPayload = {
      skill: "bug_triage",
      content: "Fix the login bug",
      prompt: "Triage this issue",
      targets: ["ava"],
      _routed: false,
      runId: "run-1",
      projectSlug: "proto-workstacean",
      skillHint: "bug_triage",
      isDM: false,
      meta: {
        agentId: "ava",
        skillHint: "bug_triage",
        topic: "agent.skill.request",
        context: { env: "prod" },
      },
    };
    expect(payload.skill).toBe("bug_triage");
    expect(payload.targets).toEqual(["ava"]);
    expect(payload.meta?.agentId).toBe("ava");
  });

  test("accepts additional arbitrary fields via index signature", () => {
    const payload: AgentSkillRequestPayload = {
      skill: "daily_standup",
      discordChannels: { general: "123", updates: "456" },
      githubOwner: "protoLabsAI",
    };
    expect(payload.discordChannels).toBeDefined();
  });
});

describe("AgentSkillResponsePayload", () => {
  test("success response shape", () => {
    const payload: AgentSkillResponsePayload = {
      content: "The answer is 42",
      correlationId: "corr-1",
    };
    expect(payload.content).toBe("The answer is 42");
    expect(payload.error).toBeUndefined();
    expect(payload.correlationId).toBe("corr-1");
  });

  test("error response shape", () => {
    const payload: AgentSkillResponsePayload = {
      error: "Agent timeout",
      correlationId: "corr-2",
    };
    expect(payload.error).toBe("Agent timeout");
    expect(payload.content).toBeUndefined();
  });
});

describe("InboundMessagePayload", () => {
  test("minimal payload with no fields", () => {
    const payload: InboundMessagePayload = {};
    expect(payload).toBeDefined();
  });

  test("full inbound message payload shape", () => {
    const payload: InboundMessagePayload = {
      content: "Deploy the hotfix",
      skillHint: "deploy",
      isDM: true,
      _routed: false,
      projectSlug: "my-project",
      discordChannels: {
        general: "111",
        updates: "222",
        dev: "333",
        alerts: "444",
        releases: "555",
      },
      github: {
        owner: "protoLabsAI",
        repo: "workstacean",
      },
    };
    expect(payload.content).toBe("Deploy the hotfix");
    expect(payload.discordChannels?.dev).toBe("333");
    expect(payload.github?.owner).toBe("protoLabsAI");
  });
});

describe("CronPayload", () => {
  test("minimal cron payload", () => {
    const payload: CronPayload = {};
    expect(payload).toBeDefined();
  });

  test("full cron payload shape", () => {
    const payload: CronPayload = {
      content: "Run daily standup",
      skillHint: "daily_standup",
      channel: "discord",
      recipient: "U12345",
    };
    expect(payload.skillHint).toBe("daily_standup");
    expect(payload.channel).toBe("discord");
  });
});

describe("FlowItemPayload", () => {
  test("requires id field", () => {
    const payload: FlowItemPayload = { id: "item-1" };
    expect(payload.id).toBe("item-1");
  });

  test("full flow item payload shape", () => {
    const now = Date.now();
    const payload: FlowItemPayload = {
      id: "item-2",
      type: "feature",
      status: "active",
      stage: "running",
      createdAt: now,
      startedAt: now + 100,
      completedAt: now + 5000,
      meta: { skillName: "deploy", executorType: "a2a" },
    };
    expect(payload.type).toBe("feature");
    expect(payload.status).toBe("active");
    expect(payload.stage).toBe("running");
    expect(payload.meta?.skillName).toBe("deploy");
  });
});

describe("IncidentReportedPayload", () => {
  test("satisfies type contract", () => {
    const payload: IncidentReportedPayload = {
      incident: {
        id: "inc-001",
        title: "Database connection pool exhausted",
        severity: "critical",
        status: "open",
        reportedAt: new Date().toISOString(),
        description: "All connections in use",
        affectedProjects: ["auth-service"],
        assignee: "on-call-engineer",
      },
    };
    expect(payload.incident.severity).toBe("critical");
    expect(payload.incident.status).toBe("open");
    expect(payload.incident.affectedProjects).toContain("auth-service");
  });

  test("optional fields may be omitted", () => {
    const payload: IncidentReportedPayload = {
      incident: {
        id: "inc-002",
        title: "Minor latency spike",
        severity: "low",
        status: "resolved",
        reportedAt: new Date().toISOString(),
      },
    };
    expect(payload.incident.description).toBeUndefined();
    expect(payload.incident.assignee).toBeUndefined();
  });
});

describe("CeremonyExecutePayload", () => {
  test("manual execute shape", () => {
    const payload: CeremonyExecutePayload = {
      type: "manual.execute",
      triggeredBy: "api",
      ceremonyId: "daily-standup",
    };
    expect(payload.type).toBe("manual.execute");
    expect(payload.triggeredBy).toBe("api");
    expect(payload.ceremonyId).toBe("daily-standup");
  });

  test("scheduled execute shape", () => {
    const payload: CeremonyExecutePayload = {
      type: "scheduled.execute",
      triggeredBy: "scheduler",
    };
    expect(payload.type).toBe("scheduled.execute");
    expect(payload.ceremonyId).toBeUndefined();
  });
});

/**
 * SkillBrokerPlugin — routes agent.skill.request events to registered A2A agents.
 *
 * When CeremonyPlugin fires a ceremony, it publishes agent.skill.request and
 * waits up to 120s for agent.skill.response.{runId}. Without a subscriber,
 * every ceremony execution times out. This plugin bridges the gap.
 *
 * Resolution order:
 *   1. targets[] — if ceremony specifies target agent names, dispatch to those agents
 *   2. skill → agents.yaml lookup — find the first agent that declares the skill
 *
 * Inbound:  agent.skill.request
 * Outbound: agent.skill.response.{runId}  (or the reply topic in msg.reply.topic)
 *
 * Config: workspace/agents.yaml (A2A URLs and skill registrations)
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";

// ── Agent registry types ──────────────────────────────────────────────────────

interface AgentSkill {
  name: string;
  description?: string;
}

interface AgentDef {
  name: string;
  url: string;
  apiKeyEnv?: string;
  skills?: Array<AgentSkill | string>;
}

// ── A2A JSON-RPC call ─────────────────────────────────────────────────────────

async function callAgentA2A(
  agent: AgentDef,
  skill: string,
  ceremonyId: string,
  ceremonyName: string,
  runId: string,
  targets: string[],
): Promise<string> {
  const apiKey = agent.apiKeyEnv ? (process.env[agent.apiKeyEnv] ?? "") : "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const text = [
    `Execute skill: ${skill}`,
    `Ceremony: ${ceremonyName} (${ceremonyId})`,
    targets.length > 0 ? `Targets: ${targets.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const resp = await fetch(agent.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text }],
        },
        contextId: runId,
        metadata: { skillHint: skill, ceremonyId, runId, targets },
      },
    }),
    // Slightly under the 120s ceremony timeout so broker failure surfaces before ceremony timeout
    signal: AbortSignal.timeout(110_000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "(no body)");
    throw new Error(`A2A call to ${agent.name} failed (HTTP ${resp.status}): ${errText}`);
  }

  const data = (await resp.json()) as {
    error?: { message: string };
    result?: { status?: string; message?: string; [key: string]: unknown };
  };

  if (data.error) throw new Error(data.error.message);

  return data.result?.message ?? `Skill "${skill}" accepted by ${agent.name}`;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class SkillBrokerPlugin implements Plugin {
  readonly name = "skill-broker";
  readonly description =
    "Routes agent.skill.request events from CeremonyPlugin to registered A2A agents";
  readonly capabilities = ["skill-dispatch", "a2a-routing"];

  private bus?: EventBus;
  private agents: AgentDef[] = [];
  private readonly subscriptionIds: string[] = [];
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  install(bus: EventBus): void {
    this.bus = bus;
    this.agents = this._loadAgents();

    const subId = bus.subscribe("agent.skill.request", this.name, (msg: BusMessage) => {
      void this._handleSkillRequest(msg);
    });
    this.subscriptionIds.push(subId);

    console.log(
      `[skill-broker] Plugin installed — ${this.agents.length} agent(s) registered`,
    );
  }

  uninstall(): void {
    if (this.bus) {
      for (const id of this.subscriptionIds) {
        this.bus.unsubscribe(id);
      }
    }
    this.subscriptionIds.length = 0;
    this.bus = undefined;
  }

  private async _handleSkillRequest(msg: BusMessage): Promise<void> {
    // Handles two payload shapes:
    //   CeremonyPlugin:       { skill, ceremonyId, ceremonyName, targets, runId }
    //   ActionDispatcherPlugin: { actionId, goalId, meta: { skillHint, agentId } }
    const payload = msg.payload as {
      // CeremonyPlugin fields
      skill?: string;
      ceremonyId?: string;
      ceremonyName?: string;
      targets?: string[];
      runId?: string;
      projectPaths?: string[];
      // ActionDispatcher fields
      actionId?: string;
      goalId?: string;
      meta?: { skillHint?: string; agentId?: string; topic?: string };
    };

    const skill = payload.skill ?? payload.meta?.skillHint ?? "";
    const targets = payload.targets ?? (payload.meta?.agentId ? [payload.meta.agentId] : []);
    const runId = payload.runId ?? msg.correlationId;
    const ceremonyId = payload.ceremonyId ?? payload.actionId ?? "action";
    const ceremonyName = payload.ceremonyName ?? payload.goalId ?? "World Engine Action";

    const replyTopic = (msg as BusMessage & { reply?: { topic?: string } }).reply?.topic
      ?? `agent.skill.response.${runId}`;

    // Resolution: targets first (explicit agent names), then skill → registry lookup
    const agent = this._resolveAgent(skill, targets);

    if (!skill) {
      console.warn(`[skill-broker] Received skill request with no skill — dropping`);
      this._publishResponse(replyTopic, runId, undefined, "No skill specified in request");
      return;
    }

    if (!agent) {
      const searched = targets.length > 0
        ? `targets [${targets.join(", ")}] or skill "${skill}"`
        : `skill "${skill}"`;
      console.warn(`[skill-broker] No agent found for ${searched} — failing fast`);
      this._publishResponse(replyTopic, runId, undefined, `No agent registered for ${searched}`);
      return;
    }

    console.log(
      `[skill-broker] Dispatching skill "${skill}" → agent "${agent.name}" ` +
      `(ceremony: ${ceremonyId}, run: ${runId})`,
    );

    try {
      const result = await callAgentA2A(agent, skill, ceremonyId, ceremonyName, runId, targets);
      console.log(`[skill-broker] Agent "${agent.name}" responded for run ${runId}: ${result.slice(0, 100)}`);
      this._publishResponse(replyTopic, runId, result, undefined);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[skill-broker] A2A call to "${agent.name}" failed: ${errorMsg}`);
      this._publishResponse(replyTopic, runId, undefined, errorMsg);
    }
  }

  /**
   * Find the agent to dispatch to.
   * Priority: named target that matches an agent → skill registry lookup.
   */
  private _resolveAgent(skill: string, targets: string[]): AgentDef | undefined {
    // 1. If any target explicitly names a registered agent, use the first match
    for (const target of targets) {
      const byName = this.agents.find(a => a.name === target);
      if (byName) return byName;
    }
    // 2. Find first agent that declares this skill
    return this.agents.find(a =>
      (a.skills ?? []).some(s => {
        const skillName = typeof s === "string" ? s : (s as AgentSkill).name;
        return skillName === skill;
      }),
    );
  }

  private _publishResponse(
    replyTopic: string,
    runId: string,
    result: string | undefined,
    error: string | undefined,
  ): void {
    if (!this.bus) return;
    this.bus.publish(replyTopic, {
      id: crypto.randomUUID(),
      correlationId: runId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: { result, error, runId },
    });
  }

  private _loadAgents(): AgentDef[] {
    const agentsPath = join(this.workspaceDir, "agents.yaml");
    if (!existsSync(agentsPath)) {
      console.warn("[skill-broker] agents.yaml not found — skill dispatch will fail");
      return [];
    }
    try {
      const raw = readFileSync(agentsPath, "utf8");
      const parsed = parseYaml(raw) as { agents?: AgentDef[] };
      return parsed.agents ?? [];
    } catch (err) {
      console.error("[skill-broker] Failed to load agents.yaml:", err);
      return [];
    }
  }
}

/**
 * AgentRuntimePlugin — in-process agent execution via @protolabsai/sdk.
 *
 * This plugin replaces the external A2A/JSON-RPC pattern with in-process
 * subprocess execution. Each agent runs as a proto CLI child process with
 * a whitelisted set of workstacean MCP tools injected at invocation time.
 *
 * Subscribes to:  agent.skill.request
 * Publishes to:   agent.skill.response.<runId>  (or msg.reply.topic)
 *
 * Agent resolution order (matches existing SkillBrokerPlugin priority):
 *   1. targets[] — if the request names specific agent(s), use the first match
 *   2. skill → YAML skills[] lookup — first agent declaring the skill wins
 *
 * Config:
 *   workspace/agents/*.yaml (one file per agent, *.example skipped)
 *
 * Co-existence:
 *   AgentRuntimePlugin and SkillBrokerPlugin can run simultaneously.
 *   AgentRuntimePlugin handles agents it knows about (in-process); if no
 *   match is found here, the bus message is NOT consumed — SkillBrokerPlugin
 *   will handle external/remote agents. Use DISABLE_SKILL_BROKER=true once
 *   all agents are migrated.
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { AgentExecutor } from "./agent-executor.ts";
import { loadAgentDefinitions } from "./agent-definition-loader.ts";
import { createBusTools } from "./tools/index.ts";
import type { AgentDefinition } from "./types.ts";
import type { AgentExecutorConfig } from "./agent-executor.ts";

export interface AgentRuntimeConfig extends AgentExecutorConfig {
  /** Path to the workspace directory containing agents/. */
  workspaceDir: string;
  /** Base URL of the protoWorkstacean HTTP API for bus tools. Default: http://localhost:3000 */
  apiBaseUrl?: string;
  /** API key for the HTTP API. Default: process.env.WORKSTACEAN_API_KEY */
  apiKey?: string;
}

export class AgentRuntimePlugin implements Plugin {
  readonly name = "agent-runtime";
  readonly description =
    "In-process agent execution via @protolabsai/sdk — routes agent.skill.request to in-process agents";
  readonly capabilities = ["skill-dispatch", "in-process-agents", "a2a-routing"];

  private bus?: EventBus;
  private readonly toolRegistry = new ToolRegistry();
  private definitions: AgentDefinition[] = [];
  private readonly subscriptionIds: string[] = [];
  private readonly config: AgentRuntimeConfig;

  constructor(config: AgentRuntimeConfig) {
    this.config = config;
  }

  install(bus: EventBus): void {
    this.bus = bus;

    // Register all built-in workstacean tools
    const busTools = createBusTools({
      baseUrl: this.config.apiBaseUrl ?? "http://localhost:3000",
      apiKey: this.config.apiKey ?? process.env.WORKSTACEAN_API_KEY,
    });
    this.toolRegistry.registerAll(busTools);

    // Load agent definitions from workspace/agents/*.yaml
    this.definitions = loadAgentDefinitions(this.config.workspaceDir);

    const subId = bus.subscribe(
      "agent.skill.request",
      this.name,
      (msg: BusMessage) => { void this._handleSkillRequest(msg); },
    );
    this.subscriptionIds.push(subId);

    const agentNames = this.definitions.map(d => d.name).join(", ") || "(none)";
    console.log(
      `[agent-runtime] Plugin installed — ${this.definitions.length} agent(s): ${agentNames}` +
      ` | ${this.toolRegistry.size} tool(s): ${this.toolRegistry.names().join(", ")}`,
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
    const payload = msg.payload as {
      skill?: string;
      ceremonyId?: string;
      ceremonyName?: string;
      targets?: string[];
      runId?: string;
      meta?: { skillHint?: string; agentId?: string };
      projectPaths?: string[];
      // additional context
      content?: string;
      prompt?: string;
    };

    const skill = payload.skill ?? payload.meta?.skillHint ?? "";
    const targets = payload.targets ?? (payload.meta?.agentId ? [payload.meta.agentId] : []);
    const runId = payload.runId ?? msg.correlationId;
    const replyTopic =
      (msg as BusMessage & { reply?: { topic?: string } }).reply?.topic ??
      `agent.skill.response.${runId}`;

    // Try to resolve to an in-process agent
    const agent = this._resolveAgent(skill, targets);
    if (!agent) {
      // Not our agent — let SkillBrokerPlugin (or another subscriber) handle it
      return;
    }

    const ceremonyName = payload.ceremonyName ?? skill;
    console.log(
      `[agent-runtime] Dispatching skill "${skill}" → agent "${agent.name}" (run: ${runId})`,
    );

    // Build the prompt from the payload
    const prompt = this._buildPrompt(payload, skill, ceremonyName, targets);

    const executor = new AgentExecutor(agent, this.toolRegistry, {
      gatewayUrl: this.config.gatewayUrl,
      gatewayApiKey: this.config.gatewayApiKey,
    });

    try {
      const result = await executor.run({
        prompt,
        correlationId: runId,
      });

      if (result.isError) {
        console.error(
          `[agent-runtime] Agent "${agent.name}" returned error for run ${runId}: ${result.text.slice(0, 200)}`,
        );
      } else {
        console.log(
          `[agent-runtime] Agent "${agent.name}" completed run ${runId}` +
          ` (${result.stopReason ?? "done"})`,
        );
      }

      this._publishResponse(replyTopic, runId, result.isError ? undefined : result.text, result.isError ? result.text : undefined);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[agent-runtime] Executor error for "${agent.name}" run ${runId}: ${errorMsg}`);
      this._publishResponse(replyTopic, runId, undefined, errorMsg);
    }
  }

  /**
   * Resolution priority: named targets first → skill registry fallback.
   */
  private _resolveAgent(skill: string, targets: string[]): AgentDefinition | undefined {
    // 1. Explicit target names
    for (const target of targets) {
      const match = this.definitions.find(d => d.name === target);
      if (match) return match;
    }
    // 2. Skill registry lookup
    if (skill) {
      return this.definitions.find(d => d.skills.some(s => s.name === skill));
    }
    return undefined;
  }

  private _buildPrompt(
    payload: Record<string, unknown>,
    skill: string,
    ceremonyName: string,
    targets: string[],
  ): string {
    // Use explicit content/prompt if provided
    if (typeof payload.content === "string" && payload.content.trim()) {
      return payload.content.trim();
    }
    if (typeof payload.prompt === "string" && payload.prompt.trim()) {
      return payload.prompt.trim();
    }

    // Synthesise a prompt from ceremony metadata
    const lines = [`Execute skill: ${skill}`, `Ceremony: ${ceremonyName}`];
    if (targets.length > 0) lines.push(`Targets: ${targets.join(", ")}`);

    const context = Object.entries(payload)
      .filter(([k]) => !["skill", "ceremonyId", "ceremonyName", "targets", "runId", "meta", "content", "prompt"].includes(k))
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join("\n");

    if (context) lines.push("", "Context:", context);

    return lines.join("\n");
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
}

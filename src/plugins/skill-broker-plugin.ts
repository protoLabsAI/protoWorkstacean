/**
 * SkillBrokerPlugin — registers A2AExecutor instances with ExecutorRegistry.
 *
 * Reads workspace/agents.yaml on install, creates one A2AExecutor per agent
 * definition, and registers each skill declared for that agent.
 *
 * This plugin is a registrar only — it does NOT subscribe to agent.skill.request.
 * SkillDispatcherPlugin is the sole subscriber and delegates to the registry.
 *
 * Config: workspace/agents.yaml (A2A URLs and skill registrations)
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Plugin, EventBus } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import { A2AExecutor } from "../executor/executors/a2a-executor.ts";
import { resolveEnvVars } from "../utils/env-interpolation.ts";

interface AgentSkill {
  name: string;
  description?: string;
}

interface AgentDef {
  name: string;
  url: string;
  apiKeyEnv?: string;
  streaming?: boolean;
  skills?: Array<AgentSkill | string>;
}

export class SkillBrokerPlugin implements Plugin {
  readonly name = "skill-broker";
  readonly description = "Registers A2AExecutors with ExecutorRegistry from workspace/agents.yaml";
  readonly capabilities = ["executor-registrar", "a2a-routing"];

  private readonly workspaceDir: string;
  private readonly executorRegistry: ExecutorRegistry;

  constructor(workspaceDir: string, executorRegistry: ExecutorRegistry) {
    this.workspaceDir = workspaceDir;
    this.executorRegistry = executorRegistry;
  }

  install(bus: EventBus): void {
    const agents = this._loadAgents();
    const opsChannel = process.env.DISCORD_AGENT_OPS_CHANNEL ?? "";

    for (const agent of agents) {
      const executor = new A2AExecutor({
        name: agent.name,
        url: resolveEnvVars(agent.url, "skill-broker"),
        apiKeyEnv: agent.apiKeyEnv,
        streaming: agent.streaming ?? false,
        onStreamUpdate: opsChannel
          ? (update) => {
              bus.publish(`message.outbound.discord.push.${opsChannel}`, {
                id: crypto.randomUUID(),
                correlationId: crypto.randomUUID(),
                topic: `message.outbound.discord.push.${opsChannel}`,
                timestamp: Date.now(),
                payload: {
                  content: `**${agent.name}** [${update.state ?? update.type}] ${(update.text ?? "").slice(0, 300)}`,
                },
              });
            }
          : undefined,
      });

      for (const s of agent.skills ?? []) {
        const skillName = typeof s === "string" ? s : s.name;
        this.executorRegistry.register(skillName, executor, {
          agentName: agent.name,
          priority: 5,
        });
      }
    }

    console.log(`[skill-broker] Registered ${agents.length} A2A agent(s)`);
  }

  uninstall(): void {}

  private _loadAgents(): AgentDef[] {
    const agentsPath = join(this.workspaceDir, "agents.yaml");
    if (!existsSync(agentsPath)) {
      console.warn("[skill-broker] agents.yaml not found — no A2A agents registered");
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

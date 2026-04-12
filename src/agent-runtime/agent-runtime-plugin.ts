/**
 * AgentRuntimePlugin — registers in-process DeepAgentExecutor instances with ExecutorRegistry.
 *
 * Reads workspace/agents/*.yaml on install, creates one DeepAgentExecutor per agent
 * definition, and registers each skill declared in that agent's YAML.
 *
 * Uses deepagents (LangGraph-native) instead of @protolabsai/sdk — no subprocess
 * spawning, no coding-agent verification prompts. LLM calls go through
 * LiteLLM gateway via ChatOpenAI.
 *
 * Config:
 *   workspace/agents/*.yaml (one file per agent, *.example skipped)
 */

import type { Plugin, EventBus } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import { DeepAgentExecutor } from "../executor/executors/deep-agent-executor.ts";
import { loadAgentDefinitions } from "./agent-definition-loader.ts";
import { BUS_TOOL_NAMES } from "./tools/bus-tools.ts";

export interface AgentRuntimeConfig {
  workspaceDir: string;
  gatewayUrl?: string;
  gatewayApiKey?: string;
  apiBaseUrl?: string;
  apiKey?: string;
}

export class AgentRuntimePlugin implements Plugin {
  readonly name = "agent-runtime";
  readonly description =
    "Registers in-process DeepAgentExecutors with ExecutorRegistry from workspace/agents/*.yaml";
  readonly capabilities = ["executor-registrar", "in-process-agents"];

  private readonly config: AgentRuntimeConfig;
  private readonly executorRegistry: ExecutorRegistry;

  constructor(config: AgentRuntimeConfig, executorRegistry: ExecutorRegistry) {
    this.config = config;
    this.executorRegistry = executorRegistry;
  }

  install(_bus: EventBus): void {
    const definitions = loadAgentDefinitions(this.config.workspaceDir);
    const knownTools = new Set(BUS_TOOL_NAMES as readonly string[]);

    for (const def of definitions) {
      const unknownTools = (def.tools ?? []).filter(t => !knownTools.has(t));
      if (unknownTools.length > 0) {
        console.warn(
          `[agent-runtime] WARNING: agent ${def.name} declares unknown tools: ${unknownTools.join(", ")}`,
        );
      }

      const executor = new DeepAgentExecutor(def, {
        gatewayUrl: this.config.gatewayUrl,
        gatewayApiKey: this.config.gatewayApiKey,
        apiBaseUrl: this.config.apiBaseUrl ?? "http://localhost:3000",
        apiKey: this.config.apiKey ?? process.env.WORKSTACEAN_API_KEY,
      });

      for (const skill of def.skills) {
        this.executorRegistry.register(skill.name, executor, {
          agentName: def.name,
          priority: 10,
        });
      }
    }

    const agentNames = definitions.map(d => d.name).join(", ") || "(none)";
    console.log(`[agent-runtime] Registered ${definitions.length} deep agent(s): ${agentNames}`);
  }

  uninstall(): void {}
}

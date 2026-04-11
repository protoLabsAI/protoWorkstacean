/**
 * AgentRuntimePlugin — registers in-process ProtoSdkExecutor instances with ExecutorRegistry.
 *
 * Reads workspace/agents/*.yaml on install, creates one ProtoSdkExecutor per agent
 * definition, and registers each skill declared in that agent's YAML.
 *
 * This plugin is a registrar only — it does NOT subscribe to agent.skill.request.
 * SkillDispatcherPlugin is the sole subscriber and delegates to the registry.
 *
 * Config:
 *   workspace/agents/*.yaml (one file per agent, *.example skipped)
 */

import type { Plugin, EventBus } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { ProtoSdkExecutor } from "../executor/executors/proto-sdk-executor.ts";
import { loadAgentDefinitions } from "./agent-definition-loader.ts";
import { createBusTools } from "./tools/index.ts";
import type { AgentExecutorConfig } from "./agent-executor.ts";
import { CONFIG } from "../config/env.ts";

export interface AgentRuntimeConfig extends AgentExecutorConfig {
  workspaceDir: string;
  apiBaseUrl?: string;
  apiKey?: string;
}

export class AgentRuntimePlugin implements Plugin {
  readonly name = "agent-runtime";
  readonly description =
    "Registers in-process ProtoSdkExecutors with ExecutorRegistry from workspace/agents/*.yaml";
  readonly capabilities = ["executor-registrar", "in-process-agents"];

  private readonly toolRegistry = new ToolRegistry();
  private readonly config: AgentRuntimeConfig;
  private readonly executorRegistry: ExecutorRegistry;

  constructor(config: AgentRuntimeConfig, executorRegistry: ExecutorRegistry) {
    this.config = config;
    this.executorRegistry = executorRegistry;
  }

  install(_bus: EventBus): void {
    // Register all built-in workstacean tools
    const busTools = createBusTools({
      baseUrl: this.config.apiBaseUrl ?? "http://localhost:3000",
      apiKey: this.config.apiKey ?? CONFIG.WORKSTACEAN_API_KEY,
    });
    this.toolRegistry.registerAll(busTools);

    // Load agent definitions and register one ProtoSdkExecutor per skill
    const definitions = loadAgentDefinitions(this.config.workspaceDir);

    for (const def of definitions) {
      const executor = new ProtoSdkExecutor(def, this.toolRegistry, {
        gatewayUrl: this.config.gatewayUrl,
        gatewayApiKey: this.config.gatewayApiKey,
      });

      for (const skill of def.skills) {
        this.executorRegistry.register(skill.name, executor, {
          agentName: def.name,
          priority: 10,
        });
      }
    }

    const agentNames = definitions.map(d => d.name).join(", ") || "(none)";
    console.log(
      `[agent-runtime] Registered ${definitions.length} agent(s): ${agentNames}` +
      ` | ${this.toolRegistry.size} tool(s)`,
    );
  }

  uninstall(): void {}
}

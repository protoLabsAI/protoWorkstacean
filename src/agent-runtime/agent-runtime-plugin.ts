/**
 * AgentRuntimePlugin — registers in-process executor instances with ExecutorRegistry.
 *
 * Reads workspace/agents/*.yaml on install, creates one executor per agent
 * definition, and registers each skill declared in that agent's YAML.
 *
 * Two backing runtimes (picked by each agent's `runtime` field, default
 * "deep-agent"):
 *
 *   - DeepAgentExecutor — LangGraph ReAct loop, workstacean-provided tools.
 *     Default. Used by orchestrators (Ava), QA (Quinn), and integrations
 *     (protobot). LLM calls go through LiteLLM gateway via ChatOpenAI.
 *
 *   - ProtoSdkExecutor — full coding-agent runtime via @protolabsai/sdk.
 *     Used for proto. The SDK's query() IS the agent runtime; workstacean
 *     just dispatches a SkillRequest into it. Same LangFuse + activity
 *     event plumbing as DeepAgent.
 *
 * Config:
 *   workspace/agents/*.yaml (one file per agent, *.example skipped)
 */

import type { Plugin, EventBus } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import type { IExecutor } from "../executor/types.ts";
import { DeepAgentExecutor } from "../executor/executors/deep-agent-executor.ts";
import { ProtoSdkExecutor } from "../executor/executors/proto-sdk-executor.ts";
import { loadAgentDefinitions } from "./agent-definition-loader.ts";
import type { AgentDefinition } from "./types.ts";
import { WorkspaceWatcher, type FileDiff } from "../../lib/workspace-watcher.ts";
import { computeAgentDiff, hashDefinition, isEmptyAgentDiff } from "./agent-diff.ts";
import { join } from "node:path";

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
  private bus?: EventBus;
  /** Currently-registered agents: name → content hash. The "running" set the on-disk state is diffed against. */
  private readonly registered = new Map<string, string>();
  private watcher?: WorkspaceWatcher;

  constructor(config: AgentRuntimeConfig, executorRegistry: ExecutorRegistry) {
    this.config = config;
    this.executorRegistry = executorRegistry;
  }

  install(bus: EventBus): void {
    this.bus = bus;
    const definitions = loadAgentDefinitions(this.config.workspaceDir);

    const counts = { "deep-agent": 0, "proto-sdk": 0 };
    for (const def of definitions) {
      const executor = this._buildExecutor(def);
      counts[def.runtime ?? "deep-agent"] += 1;

      for (const skill of def.skills) {
        this.executorRegistry.register(skill.name, executor, {
          agentName: def.name,
          priority: 10,
        });
      }
      this.registered.set(def.name, hashDefinition(def));
    }

    const agentNames = definitions.map(d => `${d.name}(${d.runtime ?? "deep-agent"})`).join(", ") || "(none)";
    console.log(
      `[agent-runtime] Registered ${definitions.length} agent(s) ` +
      `[deep-agent: ${counts["deep-agent"]}, proto-sdk: ${counts["proto-sdk"]}]: ${agentNames}`,
    );

    // ADR-0004 P1 (day 1 — detect-only): watch workspace/agents/ and report
    // drift between the on-disk definitions and the running set. The apply path
    // (build/register added, unregister/dispose removed) lands in P1 day 2.
    this.watcher = new WorkspaceWatcher({
      dirs: [join(this.config.workspaceDir, "agents")],
      onChange: (diff) => this._onAgentsChanged(diff),
    });
    this.watcher.start();
  }

  /**
   * Detect-only handler (P1 day 1): a workspace/agents/ file changed. Reload the
   * definitions and log how the on-disk state has drifted from the running set.
   * Does NOT mutate the registry yet — that's P1 day 2.
   */
  private _onAgentsChanged(diff: FileDiff): void {
    let definitions: AgentDefinition[];
    try {
      definitions = loadAgentDefinitions(this.config.workspaceDir);
    } catch (err) {
      console.error(`[agent-runtime] reload failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const agentDiff = computeAgentDiff(this.registered, definitions);
    if (isEmptyAgentDiff(agentDiff)) {
      // File touched but no semantic agent change (comment, whitespace, mtime-only).
      return;
    }
    const fileSummary = `+${diff.added.length} ~${diff.changed.length} -${diff.removed.length} file(s)`;
    console.log(
      `[agent-runtime] workspace/agents changed (${fileSummary}) — on-disk agents drift from running: ` +
      `added=[${agentDiff.added.map(d => d.name).join(", ")}] ` +
      `changed=[${agentDiff.changed.map(d => d.name).join(", ")}] ` +
      `removed=[${agentDiff.removed.join(", ")}]. ` +
      `Detect-only (P1 day 1); restart or the P1 day-2 apply picks these up.`,
    );
  }

  uninstall(): void {
    this.watcher?.stop();
    this.watcher = undefined;
  }

  /**
   * Shared tool-call telemetry hook — fires per tool_use event into
   * `agent.runtime.activity.tool.call` so the /system dashboard's
   * AgentNode animates regardless of which runtime is behind the agent.
   * Best-effort: a publish failure logs a warn but never propagates back
   * into the running agent.
   */
  private _publishToolCall = (event: {
    agentName: string;
    correlationId: string;
    skill?: string;
    toolNames: string[];
  }): void => {
    if (!this.bus) return;
    const topic = "agent.runtime.activity.tool.call";
    try {
      this.bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: event.correlationId,
        topic,
        timestamp: Date.now(),
        payload: {
          type: "tool.call",
          agentName: event.agentName,
          correlationId: event.correlationId,
          skill: event.skill,
          toolNames: event.toolNames,
          timestamp: Date.now(),
        },
      });
    } catch (err) {
      console.warn(`[agent-runtime] tool.call publish failed for ${event.agentName}:`, err);
    }
  };

  private _buildExecutor(def: AgentDefinition): IExecutor {
    const runtime = def.runtime ?? "deep-agent";
    if (runtime === "proto-sdk") {
      return new ProtoSdkExecutor(
        def,
        {
          gatewayUrl: this.config.gatewayUrl,
          gatewayApiKey: this.config.gatewayApiKey,
          onToolCall: this._publishToolCall,
        },
        this.bus,
      );
    }
    return new DeepAgentExecutor(def, {
      gatewayUrl: this.config.gatewayUrl,
      gatewayApiKey: this.config.gatewayApiKey,
      apiBaseUrl: this.config.apiBaseUrl ?? "http://localhost:3000",
      apiKey: this.config.apiKey ?? process.env.WORKSTACEAN_API_KEY,
      onToolCall: this._publishToolCall,
    });
  }
}

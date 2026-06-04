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
import type { ToolCallArtifactData } from "@protolabs/a2a";
import { DeepAgentExecutor } from "../executor/executors/deep-agent-executor.ts";
import { ProtoSdkExecutor } from "../executor/executors/proto-sdk-executor.ts";
import { AgentMemory } from "../knowledge/agent-memory.ts";
import { ConversationStore } from "../knowledge/conversation-store.ts";
import { KnowledgeStore } from "../knowledge/knowledge-store.ts";
import { ConversationHarvester } from "../knowledge/conversation-harvester.ts";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { loadAgentEntries, type AgentEntry } from "./agent-definition-loader.ts";
import type { AgentDefinition } from "./types.ts";
import { WorkspaceWatcher } from "../../lib/workspace-watcher.ts";
import { computeAgentDiff, hashDefinition } from "./agent-diff.ts";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { logger } from "../../lib/log.ts";

const log = logger("agent-runtime");

export interface AgentRuntimeConfig {
  workspaceDir: string;
  gatewayUrl?: string;
  gatewayApiKey?: string;
  apiBaseUrl?: string;
  apiKey?: string;
}

/**
 * Turn a turn's tool calls into a short human progress line for A2A streaming
 * (#777) — e.g. chat_with_agent(agent="quinn") → "routing to quinn". Returns ""
 * when there's nothing worth narrating (tools that surface their own text).
 */
export function humanizeToolProgress(calls: Array<{ name: string; args?: unknown }>): string {
  const phrases: string[] = [];
  for (const c of calls) {
    const args = (c.args ?? {}) as Record<string, unknown>;
    const name = c.name;
    if (name === "chat_with_agent" || name === "delegate_task") {
      const target = typeof args.agent === "string" ? args.agent
        : typeof args.target === "string" ? args.target : undefined;
      phrases.push(target ? `routing to ${target}` : "delegating to an agent");
    } else if (name === "searxng_search" || name === "web_search") {
      phrases.push("searching the web");
    } else if (name === "huggingface_search") {
      phrases.push("searching HuggingFace");
    } else if (name === "github_trending") {
      phrases.push("scanning GitHub");
    } else if (name.startsWith("research_")) {
      phrases.push("searching the research knowledge base");
    } else if (name.startsWith("github_") || name === "create_github_issue") {
      phrases.push("working with GitHub");
    } else if (name.startsWith("linear_")) {
      phrases.push("working with Linear");
    } else if (name === "send_update" || name === "msg_operator" || name === "ask_human") {
      // These surface their own user-facing text — don't double-narrate.
    } else {
      phrases.push(`running ${name}`);
    }
  }
  return [...new Set(phrases)].join("; ");
}

/** A running agent: its executor, the skills it's registered for, content hash, and source file. */
interface RegisteredAgent {
  executor: IExecutor;
  skills: string[];
  hash: string;
  file: string;
}

export class AgentRuntimePlugin implements Plugin {
  readonly name = "agent-runtime";
  readonly description =
    "Registers in-process DeepAgentExecutors with ExecutorRegistry from workspace/agents/*.yaml";
  readonly capabilities = ["executor-registrar", "in-process-agents"];

  private readonly config: AgentRuntimeConfig;
  private readonly executorRegistry: ExecutorRegistry;
  private bus?: EventBus;
  /** Running agents by name — the live set the on-disk definitions are reconciled against. */
  private readonly registered = new Map<string, RegisteredAgent>();
  private watcher?: WorkspaceWatcher;
  /** Executor factory — injectable for tests; defaults to the real DeepAgent / ProtoSDK builder. */
  private readonly buildExecutor: (def: AgentDefinition) => IExecutor;
  /** Shared memory flywheel for memory-enabled agents. Lazily created on first real build (or injected for tests). */
  private memory?: AgentMemory;
  /** Background harvester retiring aged-out conversations into the KB (Phase 3). */
  private harvester?: ConversationHarvester;

  constructor(
    config: AgentRuntimeConfig,
    executorRegistry: ExecutorRegistry,
    opts: { buildExecutor?: (def: AgentDefinition) => IExecutor; memory?: AgentMemory } = {},
  ) {
    this.config = config;
    this.executorRegistry = executorRegistry;
    this.buildExecutor = opts.buildExecutor ?? ((def) => this._buildExecutor(def));
    this.memory = opts.memory;
    // Tests inject buildExecutor; the harvester (real DB + LLM) only runs under
    // the real runtime so unit tests don't open a DB or start a sweep timer.
    this.realRuntime = !opts.buildExecutor;
  }

  private readonly realRuntime: boolean;

  /** The shared memory instance (lazily created), for the harvester to share. */
  private _memory(): AgentMemory {
    if (!this.memory) {
      this.memory = new AgentMemory(new ConversationStore(), new KnowledgeStore());
      this.memory.init();
    }
    return this.memory;
  }

  install(bus: EventBus): void {
    this.bus = bus;
    const entries = loadAgentEntries(this.config.workspaceDir);

    const counts = { "deep-agent": 0, "proto-sdk": 0 };
    for (const { def, file } of entries) {
      counts[def.runtime ?? "deep-agent"] += 1;
      this._register(def, file);
      log.info(`Loaded agent "${def.name}" (${def.role}, model: ${def.model})`);
    }

    const agentNames = entries.map(e => `${e.def.name}(${e.def.runtime ?? "deep-agent"})`).join(", ") || "(none)";
    log.info(
      `Registered ${entries.length} agent(s) ` +
      `[deep-agent: ${counts["deep-agent"]}, proto-sdk: ${counts["proto-sdk"]}]: ${agentNames}`,
    );

    // ADR-0004 P1: hot-reload. Watch workspace/agents/ and reconcile the live
    // registry on every change — add / reload / remove an agent with no restart.
    this.watcher = new WorkspaceWatcher({
      dirs: [join(this.config.workspaceDir, "agents")],
      onChange: () => this._applyAgentChanges(),
    });
    this.watcher.start();

    // Phase 3: harvest aged-out conversations into searchable memory. Start one
    // background sweeper when any agent opts into harvest.
    this._ensureHarvester(entries);
  }

  /**
   * Start the harvester if any current agent opts into harvest and it isn't
   * already running. Called from install() AND the hot-reload path, so an agent
   * that gains a `memory` block at runtime (e.g. ava.yaml edited live) starts
   * harvesting without waiting for a restart. Skipped under an injected test
   * executor. Idempotent — never starts a second sweeper.
   */
  private _ensureHarvester(entries: AgentEntry[]): void {
    if (this.harvester || !this.realRuntime) return;
    const wantsHarvest = entries.some(e => e.def.memory?.enabled && e.def.memory.harvest !== false);
    if (wantsHarvest) this._startHarvester();
  }

  private _startHarvester(): void {
    const memory = this._memory();
    const gatewayUrl = this.config.gatewayUrl ?? process.env.LLM_GATEWAY_URL ?? process.env.OPENAI_BASE_URL;
    const apiKey = this.config.gatewayApiKey ?? process.env.OPENAI_API_KEY ?? "unused";
    const model = process.env.MEMORY_SUMMARY_MODEL ?? "protolabs/reasoning";
    const llm = new ChatOpenAI({
      model,
      temperature: 0,
      configuration: gatewayUrl ? { baseURL: gatewayUrl } : undefined,
      apiKey,
    });
    const SUMMARY_PROMPT =
      "Summarize this conversation for long-term, searchable memory. Capture the " +
      "user's goals, the concrete facts/preferences/decisions, and outcomes — " +
      "anything worth recalling in a future conversation. Write a concise factual " +
      "summary (a few sentences). Omit pleasantries and meta-commentary.";
    const maxAgeDays = Number(process.env.MEMORY_HARVEST_MAX_AGE_DAYS ?? 7);
    const sweepHours = Number(process.env.MEMORY_HARVEST_SWEEP_HOURS ?? 6);
    this.harvester = new ConversationHarvester(memory, {
      summarize: async (transcript) => {
        const resp = await llm.invoke([new SystemMessage(SUMMARY_PROMPT), new HumanMessage(transcript)]);
        return typeof resp.content === "string" ? resp.content : String(resp.content);
      },
      maxAgeMs: maxAgeDays * 86_400_000,
      sweepIntervalMs: sweepHours * 3_600_000,
    });
    this.harvester.start();
  }

  /** Build an executor for `def`, register its skills, and record it as running. */
  private _register(def: AgentDefinition, file: string): void {
    const executor = this.buildExecutor(def);
    const skills = def.skills.map(s => s.name);
    for (const skill of skills) {
      this.executorRegistry.register(skill, executor, { agentName: def.name, priority: 10 });
    }
    this.registered.set(def.name, { executor, skills, hash: hashDefinition(def), file });
  }

  /**
   * P1 apply: reload workspace/agents/ and reconcile the live registry —
   * register added agents, re-register changed ones, unregister + dispose
   * removed ones. No restart.
   *
   * Safety: a file that fails to parse is dropped from the loaded set, which
   * would otherwise look like a removal. We only treat an agent as removed when
   * its source file is actually GONE; if the file is still present, the agent
   * vanished due to a parse error and we KEEP the running instance — a typo
   * never silently drops a live agent.
   */
  private _applyAgentChanges(): void {
    let entries: AgentEntry[];
    try {
      entries = loadAgentEntries(this.config.workspaceDir);
    } catch (err) {
      log.error(`reload failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const fileByName = new Map(entries.map(e => [e.def.name, e.file]));
    const registeredHashes = new Map([...this.registered].map(([name, r]) => [name, r.hash]));
    const diff = computeAgentDiff(registeredHashes, entries.map(e => e.def));

    for (const name of diff.removed) {
      const reg = this.registered.get(name);
      if (!reg) continue;
      if (existsSync(reg.file)) {
        log.warn(
          `"${name}" no longer parses from ${basename(reg.file)} — keeping the running instance (fix or delete the file)`,
        );
        continue;
      }
      this._removeAgent(name, reg);
    }

    for (const def of diff.added) {
      this._register(def, fileByName.get(def.name) ?? "");
      log.info(`+ "${def.name}" hot-added (${def.skills.length} skill(s)) — no restart`);
    }

    for (const def of diff.changed) {
      const old = this.registered.get(def.name);
      if (!old) continue;
      for (const skill of old.skills) this.executorRegistry.unregister(skill, def.name);
      this._register(def, fileByName.get(def.name) ?? old.file);
      this._disposeExecutor(def.name, old.executor);
      log.info(`~ "${def.name}" reloaded (${def.skills.length} skill(s)) — no restart`);
    }

    // An agent may have just gained a `memory` block via the live edit — start
    // the harvester now instead of waiting for the next restart.
    this._ensureHarvester(entries);
  }

  private _removeAgent(name: string, reg: RegisteredAgent): void {
    for (const skill of reg.skills) this.executorRegistry.unregister(skill, name);
    this.registered.delete(name);
    this._disposeExecutor(name, reg.executor);
    log.info(`- "${name}" hot-removed (${reg.skills.length} skill(s) unregistered) — no restart`);
  }

  /** Best-effort executor teardown — never blocks the apply or aborts in-flight work. */
  private _disposeExecutor(name: string, executor: IExecutor): void {
    void Promise.resolve()
      .then(() => executor.dispose?.())
      .catch((err) =>
        log.warn(`dispose("${name}") failed: ${err instanceof Error ? err.message : String(err)}`),
      );
  }

  uninstall(): void {
    this.watcher?.stop();
    this.watcher = undefined;
    this.harvester?.stop();
    this.harvester = undefined;
    this.memory?.close();
    this.memory = undefined;
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
    toolCalls?: Array<{ name: string; args?: unknown }>;
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
      log.warn(`tool.call publish failed for ${event.agentName}`, { err });
    }

    // Also emit real streaming progress: a2a-server translates
    // agent.skill.progress.{correlationId} {text} into a `working` status-update
    // with status.message, so A2A clients narrate actual steps instead of bare
    // heartbeats. (#777) Best-effort — never breaks a running skill.
    const text = humanizeToolProgress(event.toolCalls ?? event.toolNames.map(name => ({ name })));
    if (!text) return;
    const progressTopic = `agent.skill.progress.${event.correlationId}`;
    try {
      this.bus.publish(progressTopic, {
        id: crypto.randomUUID(),
        correlationId: event.correlationId,
        topic: progressTopic,
        timestamp: Date.now(),
        payload: { text, step: "tool_call", meta: { tools: event.toolNames } },
      });
    } catch (err) {
      log.warn(`progress publish failed for ${event.agentName}`, { err });
    }
  };

  /**
   * Generic progress hook — bridges non-tool milestones (e.g. the initial
   * "thinking" frame) to `agent.skill.progress.{correlationId}` so A2A callers
   * narrate them as `working` status-updates, same channel as tool-call
   * narration. Best-effort — never breaks a running skill.
   */
  private _publishProgress = (event: {
    agentName: string;
    correlationId: string;
    skill?: string;
    text: string;
    step?: string;
  }): void => {
    if (!this.bus || !event.text) return;
    const progressTopic = `agent.skill.progress.${event.correlationId}`;
    try {
      this.bus.publish(progressTopic, {
        id: crypto.randomUUID(),
        correlationId: event.correlationId,
        topic: progressTopic,
        timestamp: Date.now(),
        payload: { text: event.text, step: event.step ?? "progress" },
      });
    } catch (err) {
      log.warn(`progress publish failed for ${event.agentName}`, { err });
    }
  };

  /**
   * Structured tool-call frame hook (tool-call-v1) — bridges each tool
   * lifecycle frame to `agent.skill.toolframe.{correlationId}` so the a2a-server
   * can emit it as a streamed artifact-update DataPart. Best-effort.
   */
  private _publishToolFrame = (event: {
    agentName: string;
    correlationId: string;
    skill?: string;
    frame: ToolCallArtifactData;
  }): void => {
    if (!this.bus) return;
    const topic = `agent.skill.toolframe.${event.correlationId}`;
    try {
      this.bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: event.correlationId,
        topic,
        timestamp: Date.now(),
        payload: { frame: event.frame },
      });
    } catch (err) {
      log.warn(`toolframe publish failed for ${event.agentName}`, { err });
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
      onProgress: this._publishProgress,
      onToolFrame: this._publishToolFrame,
      // Share one memory instance across agents; only memory-enabled agents use it.
      memory: def.memory?.enabled ? this._memory() : undefined,
    });
  }
}

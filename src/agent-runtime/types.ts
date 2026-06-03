/**
 * Agent runtime type definitions.
 *
 * AgentDefinition is the config-driven description of a single agent loaded
 * from workspace/agents/<name>.yaml. It drives tool whitelisting, model
 * selection, delegation rules, and bus subscription patterns.
 */

import type { AgentMemoryConfig } from "../knowledge/agent-memory.ts";

export type { AgentMemoryConfig };

export type AgentRole =
  | "orchestrator"   // Ava — delegates to subagents, drives plans
  | "qa"             // Quinn — code review, bug triage
  | "devops"         // Frank — CI, infra, deploy
  | "content"        // Jon / Cindi — comms, content, summaries
  | "research"       // Researcher — deep context retrieval
  | "general";       // catch-all for future agents

/**
 * A single skill the agent can execute.
 * The `name` field must match a `skillHint` value sent on agent.skill.request.
 */
export interface AgentSkillDefinition {
  name: string;
  description?: string;
  /**
   * Keywords/phrases that trigger this skill via content matching.
   * Case-insensitive substring search against message content.
   * Example: ["bug", "broken", "crash", "error", "triage"]
   */
  keywords?: string[];
  /** Override the system prompt for this specific skill. */
  systemPromptOverride?: string;
  /**
   * Restrict tools available when this skill executes. If set, the runtime
   * intersects with the agent's `tools[]` — a skill cannot add tools the
   * agent doesn't already declare. If unset, all of agent.tools are
   * available. Use this to prevent a focused skill (e.g. pr_review) from
   * fanning out into delegation / web search territory and exhausting
   * the recursion limit.
   */
  tools?: string[];
  /**
   * Override the agent's `maxTurns` for this skill. Recursion limit in
   * LangGraph is `maxTurns * 2 + 1` — bump for skills that need many
   * tool calls (e.g. board sweeps), keep tight for narrow ones.
   */
  maxTurns?: number;
  /**
   * JSON-Schema description of this skill's structured result. When set, the
   * runtime runs a forced structured finalizer after the agent's reasoning
   * loop: it binds a `submit_<skill>` tool whose parameters ARE this schema,
   * forces `tool_choice` to it, validates the returned args, and emits the
   * validated object as a structured DataPart (discriminated by `resultMime`)
   * instead of free text. Omit for the unchanged free-text behavior.
   *
   * Shape is a subset of JSON Schema: `{ type: "object", properties: {...},
   * required: [...] }` with property types object | string | number | boolean |
   * array (+ enum). Carried verbatim onto the forced tool's `parameters`.
   */
  outputSchema?: JsonSchema;
  /**
   * MIME type for this skill's structured-result DataPart (e.g.
   * `application/vnd.protolabs.pr-diagnosis-v1+json`). Advertised on the
   * skill's `output_modes` in the agent card. Required whenever `outputSchema`
   * is set; the finalizer uses it as the DataPart's `metadata.mimeType`.
   */
  resultMime?: string;
}

/**
 * The subset of JSON Schema we accept for skill `outputSchema`. Loose by
 * design: it is passed verbatim to the gateway as a forced tool's `parameters`
 * (OpenAI function-calling shape) and is also walked to build a zod validator
 * for the runtime-local validation + repair step. The runtime only relies on
 * `type`, `properties`, `required`, `items`, and `enum`.
 */
export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  /** Permit additional JSON-Schema keywords without typing every one. */
  [k: string]: unknown;
}

/**
 * Complete definition of an in-process agent loaded from YAML.
 */
export interface AgentDefinition {
  /** Unique name — used as the agent key in all routing. */
  name: string;

  role: AgentRole;

  /**
   * Which in-process runtime backs this agent.
   *
   *   "deep-agent" (default) — LangGraph ReAct loop via @langchain/langgraph,
   *     workstacean-provided tools registered inline in DeepAgentExecutor.
   *     Used for Ava / Quinn / protobot — orchestrators + QA + integrations.
   *
   *   "proto-sdk" — full coding-agent runtime via @protolabsai/sdk's query().
   *     Used for proto. The agent has protoCLI's native tools
   *     (read/write/edit/shell/grep/glob/web_fetch/…) and runs its own
   *     turn loop — workstacean is just the dispatcher.
   *
   * Defaults to "deep-agent" so existing agent yamls don't need touching.
   */
  runtime?: "deep-agent" | "proto-sdk";

  /**
   * LLM model alias as recognised by the gateway.
   * Fleet default: "protolabs/reasoning" (LiteLLM resolves it to whichever
   * concrete model is currently provisioned for reasoning workloads).
   * Concrete names also work — e.g. "claude-opus-4-7", "claude-sonnet-4-6",
   * "claude-haiku-4-5-20251001" — and bypass the gateway-side alias.
   * Per-call override: dispatch payload may carry `model: "<alias>"` to
   * temporarily swap this for one invocation (wired in #613).
   */
  model: string;

  /** Full system prompt. Injected into every query() call. */
  systemPrompt: string;

  /**
   * Tool names this agent is allowed to use.
   * Must match keys registered in ToolRegistry.
   * Empty array = no workstacean tools (agent relies on proto CLI built-ins only).
   */
  tools: string[];

  /**
   * CLI built-in tools to allow (whitelist). If set, only these tools are
   * available alongside the MCP server tools. Use to create read-only agents.
   * Example: ["read_file", "grep_search", "glob", "list_directory", "web_fetch"]
   */
  allowedTools?: string[];

  /**
   * CLI built-in tools to block (blacklist). Highest priority — overrides allowedTools.
   * Example: ["edit", "write_file", "run_shell_command"]
   */
  excludeTools?: string[];

  /**
   * Names of agents this agent may delegate to (DeepAgent pattern).
   * Only meaningful for role === "orchestrator".
   */
  canDelegate?: string[];

  /**
   * Maximum number of agentic turns per invocation (-1 = unlimited).
   * @default 10
   */
  maxTurns: number;

  /** Skills this agent can handle (maps skill.name → AgentSkillDefinition). */
  skills: AgentSkillDefinition[];

  /**
   * Opt-in memory flywheel (within-conversation history + cross-conversation
   * recall + harvest). Off unless declared. Only conversational skills get it
   * (default ["chat"]) so narrow skills like pr_review stay stateless.
   */
  memory?: AgentMemoryConfig;

  /**
   * Optional Discord bot token env var. When set, DiscordPlugin's agent
   * pool spins up a dedicated Client() for this agent so users can @-mention
   * or DM the agent's bot directly instead of routing through the shared
   * protoBot listener. Only meaningful for in-process agents that want
   * their own Discord identity.
   */
  discordBotTokenEnvKey?: string;
}

/**
 * Raw YAML shape for a single agent file.
 * Intentionally loose — validated via parseAgentYaml().
 */
export interface RawAgentYaml {
  name?: unknown;
  role?: unknown;
  runtime?: unknown;
  model?: unknown;
  systemPrompt?: unknown;
  tools?: unknown;
  canDelegate?: unknown;
  maxTurns?: unknown;
  skills?: unknown;
  discordBotTokenEnvKey?: unknown;
}

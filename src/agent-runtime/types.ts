/**
 * Agent runtime type definitions.
 *
 * AgentDefinition is the config-driven description of a single agent loaded
 * from workspace/agents/<name>.yaml. It drives tool whitelisting, model
 * selection, delegation rules, and bus subscription patterns.
 */

import type { Action } from "../planner/types/action.ts";

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
}

/**
 * Complete definition of an in-process agent loaded from YAML.
 */
export interface AgentDefinition {
  /** Unique name — used as the agent key in all routing. */
  name: string;

  role: AgentRole;

  /**
   * LLM model alias as recognised by the gateway.
   * Example: "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"
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
   * GOAP actions owned by this agent. Populated into the ActionRegistry at startup.
   * Replaces the global workspace/actions.yaml — actions live alongside the agent
   * that executes them.
   */
  actions?: Action[];

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
  model?: unknown;
  systemPrompt?: unknown;
  tools?: unknown;
  canDelegate?: unknown;
  maxTurns?: unknown;
  skills?: unknown;
  actions?: unknown;
  discordBotTokenEnvKey?: unknown;
}

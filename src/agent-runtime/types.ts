/**
 * Agent runtime type definitions.
 *
 * AgentDefinition is the config-driven description of a single agent loaded
 * from workspace/agents/<name>.yaml. It drives tool whitelisting, model
 * selection, delegation rules, and bus subscription patterns.
 */

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
}

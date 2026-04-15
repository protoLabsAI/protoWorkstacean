/**
 * Typed bus event definitions for skill execution progress.
 */

export interface SkillProgressEvent {
  /** Correlation ID linking this event to the originating skill request */
  correlationId: string;
  /** Name of the skill being executed */
  skill: string;
  /** Name of the agent executing the skill */
  agentName: string;
  /** Type of intermediate event emitted by the agent */
  eventType: "tool_call" | "text" | "tool_result";
  /** Raw content of the event (tool input/output, text chunk, etc.) */
  content: unknown;
  /** Unix timestamp (ms) when this event was emitted */
  timestamp: number;
}

/** Bus topic for SkillProgressEvent messages */
export const SKILL_PROGRESS_TOPIC = "skill.progress" as const;

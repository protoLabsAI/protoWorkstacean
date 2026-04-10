/**
 * SkillResolver — maps a message to a skill name.
 *
 * Resolution order:
 *   1. Explicit skillHint in message payload — set by surface plugins
 *      (Discord slash commands, GitHub event type mapping, Plane webhooks)
 *   2. Keyword match against message content — config-driven from agent YAML
 *   3. Default skill (ROUTER_DEFAULT_SKILL env var) — optional catch-all
 *
 * The keyword map is built from workspace/agents/*.yaml at startup.
 * Adding keywords to an agent's skill definition requires no code changes.
 */

import type { AgentDefinition } from "../agent-runtime/types.ts";

export interface SkillMatch {
  skill: string;
  /** Agent name that declared this skill, if known. */
  agentName?: string;
  /** How the match was made. */
  via: "hint" | "keyword" | "default";
}

interface SkillEntry {
  skill: string;
  agentName: string;
  /** Lowercased keywords for fast comparison. */
  keywords: string[];
}

export class SkillResolver {
  private entries: SkillEntry[] = [];
  private defaultSkill: string | undefined;

  constructor(defaultSkill?: string) {
    this.defaultSkill = defaultSkill;
  }

  /**
   * Build the keyword map from a set of loaded agent definitions.
   * Call this whenever definitions are reloaded.
   */
  loadFromAgents(defs: AgentDefinition[]): void {
    this.entries = [];
    for (const def of defs) {
      for (const skill of def.skills) {
        if (!skill.keywords?.length) continue;
        this.entries.push({
          skill: skill.name,
          agentName: def.name,
          keywords: skill.keywords.map(k => k.toLowerCase()),
        });
      }
    }
  }

  /**
   * Resolve a skill from an explicit hint or message content.
   *
   * @param skillHint - explicit hint from payload (takes priority)
   * @param content   - message body to keyword-scan if no hint
   */
  resolve(skillHint: string | undefined, content: string | undefined): SkillMatch | null {
    // 1. Explicit hint from surface plugin
    if (skillHint?.trim()) {
      return { skill: skillHint.trim(), via: "hint" };
    }

    // 2. Keyword scan
    if (content) {
      const lower = content.toLowerCase();
      for (const entry of this.entries) {
        if (entry.keywords.some(kw => lower.includes(kw))) {
          return { skill: entry.skill, agentName: entry.agentName, via: "keyword" };
        }
      }
    }

    // 3. Default
    if (this.defaultSkill) {
      return { skill: this.defaultSkill, via: "default" };
    }

    return null;
  }

  /** Number of registered keyword entries. */
  get size(): number {
    return this.entries.length;
  }
}

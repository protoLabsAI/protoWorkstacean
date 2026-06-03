/**
 * AgentMemory — the in-process memory flywheel for DeepAgent agents.
 *
 * Bundles the two stores and exposes the three operations the executor needs,
 * mirroring protoAgent's KnowledgeMiddleware + MemoryMiddleware:
 *   - history(contextId)      → recent turns to replay into the next invocation
 *   - recallBlock(query)      → hot memory + BM25 hits, formatted for the prompt
 *   - record(...)             → persist the turn + extract a searchable finding
 *
 * One shared instance backs every memory-enabled agent; per-agent gating +
 * tuning come from `AgentDefinition.memory`. All ops are best-effort and never
 * throw into the caller — memory must not break a running skill.
 */

import { ConversationStore, type ConversationTurn } from "./conversation-store.ts";
import { KnowledgeStore } from "./knowledge-store.ts";

/** Per-agent memory config (from agent yaml). */
export interface AgentMemoryConfig {
  enabled: boolean;
  /** Skills that get memory. Default: ["chat"] — narrow skills (pr_review…) stay stateless. */
  skills?: string[];
  /** Recent turns replayed into the next invocation. Default 10. */
  historyTurns?: number;
  /** Knowledge hits injected per recall. Default 5. */
  recallTopK?: number;
  /** Whether aged-out conversations are harvested into the KB. Default true. */
  harvest?: boolean;
}

const DEFAULT_SKILLS = ["chat"];
const DEFAULT_HISTORY_TURNS = 10;
const DEFAULT_RECALL_TOP_K = 5;
/** Min AI-answer length to be worth storing as a finding (mirrors protoAgent's 100). */
const MIN_FINDING_CHARS = 100;
const MAX_FINDING_CHARS = 2000;

export function memoryAppliesTo(cfg: AgentMemoryConfig | undefined, skill: string | undefined): boolean {
  if (!cfg?.enabled) return false;
  const skills = cfg.skills ?? DEFAULT_SKILLS;
  // skill undefined ⇒ treat as the default conversational skill.
  return skills.includes(skill ?? "chat");
}

export class AgentMemory {
  constructor(
    readonly conversations: ConversationStore,
    readonly knowledge: KnowledgeStore,
  ) {}

  /** Init both stores (idempotent — they open the same DB file). */
  init(): void {
    this.conversations.init();
    this.knowledge.init();
  }

  /** Recent turns for a conversation, chronological. */
  history(contextId: string, cfg?: AgentMemoryConfig): ConversationTurn[] {
    return this.conversations.recentTurns(contextId, cfg?.historyTurns ?? DEFAULT_HISTORY_TURNS);
  }

  /**
   * Build the recall context block injected into the system prompt: always-on
   * hot memory + the top BM25 hits for the query. Returns "" when nothing
   * relevant — callers append only when non-empty.
   */
  recallBlock(query: string, cfg?: AgentMemoryConfig): string {
    const parts: string[] = [];
    const hot = this.knowledge.getHotMemory();
    if (hot) parts.push(`Always-on facts:\n${hot}`);

    const hits = this.knowledge.search(query, cfg?.recallTopK ?? DEFAULT_RECALL_TOP_K);
    if (hits.length > 0) {
      const lines = hits.map((h) => `- ${h.heading ? `(${h.heading}) ` : ""}${h.preview}`);
      parts.push(`Relevant context from earlier conversations:\n${lines.join("\n")}`);
    }
    return parts.join("\n\n");
  }

  /**
   * Persist a completed turn: append the user + assistant messages, and extract
   * the assistant answer as a searchable finding when it's substantive.
   */
  record(contextId: string, opts: { agent: string; skill?: string; userText: string; aiText: string }): void {
    const { agent, skill, userText, aiText } = opts;
    this.conversations.appendTurn(contextId, "user", userText, agent, skill);
    if (aiText.trim()) this.conversations.appendTurn(contextId, "assistant", aiText, agent, skill);

    const clean = aiText.trim();
    if (clean.length >= MIN_FINDING_CHARS) {
      const heading = userText.trim().slice(0, 80) || undefined;
      this.knowledge.addChunk(clean.slice(0, MAX_FINDING_CHARS), {
        domain: "finding",
        heading,
        source: `conversation:${agent}`,
      });
    }
  }

  close(): void {
    this.conversations.close();
    this.knowledge.close();
  }
}

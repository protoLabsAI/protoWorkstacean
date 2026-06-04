/**
 * ConversationHarvester — retire aged-out conversations into searchable memory.
 *
 * Ports protoAgent's conversation_harvest + checkpoint-pruner trigger. On a
 * periodic sweep it finds conversations with no activity for `maxAgeMs`,
 * summarizes each one's transcript via a cheap aux model, ingests the summary
 * into the KnowledgeStore (domain="conversation"), then deletes the raw turns.
 * Save space, keep the signal — the substance stays recallable via recall()
 * while the bulky turn-by-turn history is reclaimed.
 *
 * The summarizer is injected so this stays testable + decoupled from the LLM
 * client. Every step is best-effort: a failure on one conversation never blocks
 * the others, and never throws out of the sweep.
 */

import type { AgentMemory } from "./agent-memory.ts";
import type { ConversationTurn } from "./conversation-store.ts";
import { logger } from "../../lib/log.ts";

const log = logger("harvester");

export type Summarizer = (transcript: string) => Promise<string>;

export interface HarvesterOptions {
  summarize: Summarizer;
  /** Idle age after which a conversation is harvested. Default 7 days. */
  maxAgeMs?: number;
  /** How often to sweep. Default 6 hours. */
  sweepIntervalMs?: number;
  /** Max conversations harvested per sweep. Default 25. */
  batchLimit?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_SWEEP_MS = 6 * 60 * 60_000;
const DEFAULT_BATCH = 25;
const MAX_TRANSCRIPT_CHARS = 16000;

/** Render a User/Assistant transcript, tail-capped (mirrors protoAgent). */
export function renderTranscript(turns: ConversationTurn[]): string {
  const lines = turns
    .filter((t) => t.content.trim())
    .map((t) => `${t.role === "assistant" ? "Assistant" : "User"}: ${t.content.trim()}`);
  let transcript = lines.join("\n");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = "…\n" + transcript.slice(-MAX_TRANSCRIPT_CHARS);
  }
  return transcript;
}

export class ConversationHarvester {
  private readonly memory: AgentMemory;
  private readonly summarize: Summarizer;
  private readonly maxAgeMs: number;
  private readonly sweepIntervalMs: number;
  private readonly batchLimit: number;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(memory: AgentMemory, opts: HarvesterOptions) {
    this.memory = memory;
    this.summarize = opts.summarize;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    this.batchLimit = opts.batchLimit ?? DEFAULT_BATCH;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweepOnce(); }, this.sweepIntervalMs);
    this.timer.unref?.();
    log.info(`started — maxAge=${Math.round(this.maxAgeMs / 86_400_000)}d sweep=${Math.round(this.sweepIntervalMs / 3_600_000)}h`);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /**
   * One harvest pass. Returns the number of conversations harvested. Safe to
   * call directly (tests / manual trigger).
   */
  async sweepOnce(): Promise<number> {
    const candidates = this.memory.conversations.retirable(this.maxAgeMs, this.now(), this.batchLimit);
    let harvested = 0;
    for (const conv of candidates) {
      try {
        const turns = this.memory.conversations.allTurns(conv.contextId);
        const transcript = renderTranscript(turns);
        if (!transcript.trim()) {
          // Nothing to summarize — just reclaim it.
          this.memory.conversations.deleteConversation(conv.contextId);
          continue;
        }
        const summary = (await this.summarize(transcript)).trim();
        if (summary) {
          this.memory.knowledge.addChunk(summary, {
            domain: "conversation",
            heading: `Conversation summary${conv.agent ? ` (${conv.agent})` : ""}`,
            source: `conversation:${conv.contextId}`,
          });
          harvested += 1;
        }
        // Reclaim raw turns regardless — the summary (or empty) is the keeper.
        this.memory.conversations.deleteConversation(conv.contextId);
      } catch (err) {
        log.warn(`failed for ${conv.contextId}`, { err: err instanceof Error ? err.message : String(err) });
        // Leave it in place to retry next sweep.
      }
    }
    if (harvested > 0) log.info(`harvested ${harvested}/${candidates.length} conversation(s) into knowledge`);
    return harvested;
  }
}

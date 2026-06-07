/**
 * gateway-embed.ts — embeddings via the LiteLLM gateway (OpenAI-compatible).
 *
 * The researcher's hybrid store embeds through the fleet gateway rather than a
 * direct Ollama connection, so it uses the same provisioned, auth'd, observable
 * model surface as every other LLM call. POSTs to `${gateway}/embeddings` with
 * the OpenAI shape ({model, input}) and reads `data[0].embedding`.
 *
 * Default model `text-embedding-3-small` (1024-dim as the gateway serves it).
 * Best-effort: any failure returns null so the caller degrades to keyword-only
 * search rather than blocking ingestion.
 */

import { logger } from "../../../lib/log.ts";

const log = logger("gateway-embed");

const GATEWAY_URL = process.env.LLM_GATEWAY_URL ?? process.env.OPENAI_BASE_URL ?? "http://gateway:4000/v1";
const API_KEY = process.env.OPENAI_API_KEY ?? "";
// The fleet's shared embedding model: `qwen3-embedding` (Qwen3-Embedding-0.6B,
// 1024-dim) served by the gateway. `RESEARCH_EMBED_MODEL` kept for back-compat.
const EMBED_MODEL = process.env.EMBED_MODEL ?? process.env.RESEARCH_EMBED_MODEL ?? "qwen3-embedding";
const TIMEOUT_MS = 15_000;

interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[] }>;
}

/** Embed one text through the gateway. Returns the vector, or null on failure. */
export async function gatewayEmbed(text: string): Promise<number[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GATEWAY_URL.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.error(`failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as EmbeddingsResponse;
    const vec = data.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      log.error("empty embedding in response");
      return null;
    }
    return vec;
  } catch (err) {
    log.error("error", { err: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Drop-in API (replaces the retired ollama-client.ts) ──────────────────────
// The Qdrant indexers/retrievers and the review low-signal filter imported
// `embed` / `embedMany` from ollama-client. They now embed through the gateway
// with identical signatures, so only the import path changes.

/** Embed one text through the gateway. Returns the vector, or null on failure. */
export const embed = gatewayEmbed;

/**
 * Embed multiple texts, skipping failures. Returns `{ text, vector }` for each
 * success (failed chunks omitted), warning if the failure rate gets high.
 */
export async function embedMany(
  texts: string[],
): Promise<Array<{ text: string; vector: number[] }>> {
  const results: Array<{ text: string; vector: number[] }> = [];
  let failureCount = 0;
  for (const text of texts) {
    const vector = await gatewayEmbed(text);
    if (vector !== null) {
      results.push({ text, vector });
    } else {
      failureCount++;
      const total = results.length + failureCount;
      if (total >= 10 && failureCount / total > 0.1) {
        log.warn(`High embedding failure rate: ${failureCount}/${total}`);
      }
    }
  }
  return results;
}

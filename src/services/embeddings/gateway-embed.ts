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
const EMBED_MODEL = process.env.RESEARCH_EMBED_MODEL ?? "text-embedding-3-small";
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

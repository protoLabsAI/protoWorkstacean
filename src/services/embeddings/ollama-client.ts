/**
 * Ollama embeddings client.
 *
 * Calls the Ollama /api/embeddings endpoint to convert text to vector embeddings.
 *
 * Base URL: OLLAMA_URL env var (default: http://ollama:11434)
 * Model:    OLLAMA_EMBED_MODEL env var (default: nomic-embed-text)
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://ollama:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
const TIMEOUT_MS = 30_000; // embeddings can take a few seconds

interface OllamaEmbedResponse {
  embedding: number[];
}

/**
 * Generate an embedding vector for the given text.
 * Returns null if the Ollama service is unavailable or fails.
 */
export async function embed(text: string): Promise<number[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`[ollama] embed failed ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json() as OllamaEmbedResponse;
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      console.error("[ollama] embed returned empty embedding");
      return null;
    }

    return data.embedding;
  } catch (err) {
    console.error("[ollama] embed error:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed multiple texts, skipping failed chunks.
 * Returns array of { text, vector } — failed chunks are omitted.
 */
export async function embedMany(
  texts: string[],
): Promise<Array<{ text: string; vector: number[] }>> {
  const results: Array<{ text: string; vector: number[] }> = [];
  let failureCount = 0;

  for (const text of texts) {
    const vector = await embed(text);
    if (vector !== null) {
      results.push({ text, vector });
    } else {
      failureCount++;
      // Alert if failure rate exceeds 10%
      const total = results.length + failureCount;
      if (total >= 10 && failureCount / total > 0.1) {
        console.warn(`[ollama] High embedding failure rate: ${failureCount}/${total}`);
      }
    }
  }

  return results;
}

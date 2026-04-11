/**
 * Qdrant HTTP client — thin wrapper around the Qdrant REST API.
 *
 * All requests use a 5-second timeout. If Qdrant is unavailable the methods
 * return null / empty arrays so callers can fall back to diff-only review.
 *
 * Base URL: QDRANT_URL env var (default: http://qdrant:6333)
 */

import { CONFIG } from "../../config/env.ts";

const QDRANT_URL = CONFIG.QDRANT_URL ?? "http://qdrant:6333";
const TIMEOUT_MS = 5_000;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface QdrantVector {
  id: string | number;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantSearchResult {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
}

export interface QdrantCollectionConfig {
  vectorSize: number;
  distance?: "Cosine" | "Euclid" | "Dot";
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Collection management ──────────────────────────────────────────────────────

/**
 * Create a collection if it does not already exist.
 * Returns true on success, false if Qdrant is unavailable.
 */
export async function ensureCollection(
  name: string,
  config: QdrantCollectionConfig,
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${QDRANT_URL}/collections/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: {
          size: config.vectorSize,
          distance: config.distance ?? "Cosine",
        },
        on_disk_payload: true,
      }),
    });
    if (res.status === 200 || res.status === 409) {
      // 200 = created, 409 = already exists — both are fine
      return true;
    }
    const text = await res.text();
    console.error(`[qdrant] ensureCollection(${name}) failed ${res.status}: ${text}`);
    return false;
  } catch (err) {
    console.error(`[qdrant] ensureCollection(${name}) error:`, err);
    return false;
  }
}

/**
 * List all collection names. Returns empty array if Qdrant is unavailable.
 */
export async function listCollections(): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(`${QDRANT_URL}/collections`, { method: "GET" });
    if (!res.ok) return [];
    const data = await res.json() as { result?: { collections?: { name: string }[] } };
    return data.result?.collections?.map(c => c.name) ?? [];
  } catch {
    return [];
  }
}

// ── Point operations ───────────────────────────────────────────────────────────

/**
 * Upsert points into a collection.
 * Returns true on success, false on failure.
 */
export async function upsertPoints(
  collection: string,
  points: QdrantVector[],
): Promise<boolean> {
  if (points.length === 0) return true;
  try {
    const res = await fetchWithTimeout(`${QDRANT_URL}/collections/${collection}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points }),
    });
    if (res.ok) return true;
    const text = await res.text();
    console.error(`[qdrant] upsertPoints(${collection}) failed ${res.status}: ${text}`);
    return false;
  } catch (err) {
    console.error(`[qdrant] upsertPoints(${collection}) error:`, err);
    return false;
  }
}

/**
 * Search for similar vectors in a collection.
 * Returns top-K results sorted by score descending.
 * Returns empty array if Qdrant is unavailable.
 */
export async function searchPoints(
  collection: string,
  vector: number[],
  topK: number = 5,
  filter?: Record<string, unknown>,
): Promise<QdrantSearchResult[]> {
  try {
    const body: Record<string, unknown> = {
      vector,
      limit: topK,
      with_payload: true,
    };
    if (filter) body.filter = filter;

    const res = await fetchWithTimeout(`${QDRANT_URL}/collections/${collection}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[qdrant] search(${collection}) failed ${res.status}: ${text}`);
      return [];
    }
    const data = await res.json() as { result?: QdrantSearchResult[] };
    return data.result ?? [];
  } catch (err) {
    console.error(`[qdrant] search(${collection}) error:`, err);
    return [];
  }
}

/**
 * Count points in a collection. Returns -1 if unavailable.
 */
export async function countPoints(collection: string): Promise<number> {
  try {
    const res = await fetchWithTimeout(`${QDRANT_URL}/collections/${collection}/points/count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exact: false }),
    });
    if (!res.ok) return -1;
    const data = await res.json() as { result?: { count?: number } };
    return data.result?.count ?? 0;
  } catch {
    return -1;
  }
}

/**
 * Health check — returns true if Qdrant is reachable.
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${QDRANT_URL}/healthz`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

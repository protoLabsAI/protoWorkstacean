/**
 * WorldState TypeScript schema — generic, engine-level types only.
 *
 * Domain data is entirely application-defined. protoWorkstacean makes no
 * assumptions about what domains exist or what shape their data takes.
 * Applications (e.g. protoMaker/ava) register their own domains with the
 * WorldStateEngine via registerDomain() or workspace/domains.yaml.
 *
 * The engine provides:
 *   - WorldStateDomain<T>   — per-domain envelope with metadata
 *   - WorldState            — the full state container
 *   - WorldStateSnapshot    — persistence envelope
 */

// ── Per-domain metadata ───────────────────────────────────────────────────────

export interface WorldStateMetadata {
  collectedAt: number;    // Unix timestamp ms
  domain: string;
  tickNumber: number;
  failed?: boolean;
  errorMessage?: string;
}

// ── Domain envelope ───────────────────────────────────────────────────────────

export interface WorldStateDomain<T = unknown> {
  data: T;
  metadata: WorldStateMetadata;
}

// ── Core world state container ────────────────────────────────────────────────

export interface WorldState {
  /** Unix timestamp ms of the most recent domain update. */
  timestamp: number;
  /** Application-defined domains. Keys are domain names; values are typed envelopes. */
  domains: Record<string, WorldStateDomain<unknown>>;
  /**
   * Ephemeral extensions written by actions via effects.
   * Not persisted between snapshots. Keyed by domain or feature slug.
   */
  extensions: Record<string, unknown>;
  snapshotVersion: number;
}

// ── Snapshot envelope ─────────────────────────────────────────────────────────

export interface WorldStateSnapshot {
  worldState: WorldState;
  createdAt: number;      // Unix timestamp ms
  version: number;
}

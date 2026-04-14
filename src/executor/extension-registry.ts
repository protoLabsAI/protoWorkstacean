/**
 * ExtensionRegistry — lightweight map of known A2A protocol extensions and
 * the interceptors we want to apply when an agent declares support for them
 * in its agent card's `capabilities.extensions` list.
 *
 * The A2A spec models extensions as URIs (e.g. `https://a2a-protocol.org/ext/cost-v1`)
 * plus optional `params`. Agents advertise them in their card; clients can
 * opt-in per-request via the `a2a-extensions` header (comma-separated URIs).
 *
 * This phase is foundation only — we wire the registry, the header stamping,
 * and the interceptor hook points, but don't ship specific extension
 * implementations yet. Adding "cost tracking" or "consent negotiation" later
 * means registering an interceptor here; no other code needs to change.
 *
 * Usage:
 *   const ext = new ExtensionRegistry();
 *   ext.register({ uri: "https://a2a-protocol.org/ext/cost-v1", interceptor: costInterceptor });
 *   const headers = ext.headersFor(agentCard); // { "a2a-extensions": "https://..." }
 *   for (const i of ext.interceptorsFor(agentCard)) await i.before?.(request);
 */

import type { AgentCard } from "@a2a-js/sdk";

export interface ExtensionInterceptor {
  /** Called before a skill request is dispatched. May mutate metadata. */
  before?: (ctx: ExtensionContext) => Promise<void> | void;
  /** Called after a response is received. May attach data to the result. */
  after?: (ctx: ExtensionContext, result: { text: string; data?: Record<string, unknown> }) => Promise<void> | void;
}

export interface ExtensionContext {
  agentName: string;
  skill: string;
  correlationId: string;
  /** Mutable metadata bag — interceptors can stamp keys here. */
  metadata: Record<string, unknown>;
}

export interface ExtensionDefinition {
  /** Canonical URI from the agent card (e.g. "https://a2a-protocol.org/ext/cost-v1"). */
  uri: string;
  /** Optional interceptor applied when an agent declares this extension. */
  interceptor?: ExtensionInterceptor;
  /** Human-readable description for diagnostics. */
  description?: string;
}

export class ExtensionRegistry {
  private readonly extensions = new Map<string, ExtensionDefinition>();

  register(def: ExtensionDefinition): void {
    this.extensions.set(def.uri, def);
  }

  /** List every registered extension URI — useful for diagnostics. */
  list(): ExtensionDefinition[] {
    return Array.from(this.extensions.values());
  }

  /**
   * Return the subset of our registered extensions that the given agent card
   * declares support for. Filters by exact URI match; agents must advertise
   * each URI they actually implement.
   */
  matchAgent(card: AgentCard | undefined | null): ExtensionDefinition[] {
    if (!card?.capabilities?.extensions) return [];
    const advertised = new Set(card.capabilities.extensions.map(e => e.uri));
    return Array.from(this.extensions.values()).filter(def => advertised.has(def.uri));
  }

  /**
   * Build the `a2a-extensions` request header for an agent — a comma-
   * separated list of URIs the client wants to opt into on this call.
   * Returns an empty record when no matches exist so callers can just
   * spread the result without null-checking.
   */
  headersFor(card: AgentCard | undefined | null): Record<string, string> {
    const matches = this.matchAgent(card);
    if (matches.length === 0) return {};
    return { "a2a-extensions": matches.map(m => m.uri).join(", ") };
  }

  /** Interceptors for the subset of extensions an agent supports. */
  interceptorsFor(card: AgentCard | undefined | null): ExtensionInterceptor[] {
    return this.matchAgent(card)
      .map(d => d.interceptor)
      .filter((i): i is ExtensionInterceptor => !!i);
  }

  get size(): number {
    return this.extensions.size;
  }
}

/**
 * Singleton used by the skill broker / A2A executor. Test code can construct
 * its own ExtensionRegistry to avoid cross-test pollution.
 */
export const defaultExtensionRegistry = new ExtensionRegistry();

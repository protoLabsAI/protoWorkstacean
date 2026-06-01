/**
 * SkillBrokerPlugin — registers A2AExecutor instances with ExecutorRegistry.
 *
 * Reads workspace/agents.yaml on install, creates one A2AExecutor per agent,
 * then auto-discovers skills from each agent's /.well-known/agent-card.json.
 *
 * Skill sources (in order of priority):
 *   1. agents.yaml `skills:` block (if present) — explicit overrides
 *   2. Agent card `skills` field — auto-discovered on install + refreshed every 10 min
 *
 * If agents.yaml omits `skills:` entirely, the card is the only source.
 * If it lists skills, those take precedence and the card is used as a backup/diff.
 *
 * This plugin is a registrar only — SkillDispatcherPlugin is the sole
 * subscriber to agent.skill.request.
 *
 * Config: workspace/agents.yaml (A2A URLs and optional skill overrides)
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import type { AgentCard } from "@a2a-js/sdk";
import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import { A2AExecutor } from "../executor/executors/a2a-executor.ts";
import { resolveEnvVars } from "../utils/env-interpolation.ts";
import {
  defaultHitlModeRegistry,
  HITL_MODE_URI,
  type HitlMode,
} from "../executor/extensions/hitl-mode.ts";
import {
  defaultBlastRegistry,
  BLAST_URI,
  type BlastRadius,
} from "../executor/extensions/blast.ts";

interface AgentSkill {
  name: string;
  description?: string;
}

interface AgentAuthDef {
  /** One of: apiKey, bearer, hmac */
  scheme: "apiKey" | "bearer" | "hmac";
  credentialsEnv?: string;
}

interface AgentDef {
  name: string;
  url: string;
  apiKeyEnv?: string;
  /** Structured auth (Phase 8) — preferred over apiKeyEnv when set. */
  auth?: AgentAuthDef;
  /** Extra static request headers — e.g. extension opt-in. */
  headers?: Record<string, string>;
  streaming?: boolean;
  /**
   * Agent runs on an external network (Tailscale, public Internet) rather
   * than the shared docker network. When true, push-notification callback
   * URLs use WORKSTACEAN_BASE_URL (operator-configured external/Tailscale
   * hostname) instead of the docker-internal workstacean:3000. Required for
   * agents whose hostnames are single-label but not docker service names
   * (e.g. protoPen on steamdeck via Tailscale MagicDNS).
   */
  external?: boolean;
  skills?: Array<AgentSkill | string>;
}

const CARD_REFRESH_INTERVAL_MS = 10 * 60_000; // 10 min
const HEARTBEAT_INTERVAL_MS = 60_000;          // 1 min — fleet liveness

/**
 * Liveness probe result for a single A2A agent, refreshed on the heartbeat
 * cadence. Exposed via getFleetHealth() so the /api/agent-health endpoint
 * and the `agent_health` world-state domain can surface fleet availability.
 */
export interface AgentHealthProbe {
  agentName: string;
  url: string;
  reachable: boolean;
  latencyMs?: number;
  lastProbedAt: number;
  cardAvailable?: boolean;
  streaming?: boolean;
  pushNotifications?: boolean;
  skillCount?: number;
  error?: string;
}

/**
 * Reconcile an agent's registry against a freshly-fetched card.
 *
 *  - toAdd:    card skills not already card-registered and not a yaml override.
 *  - toRemove: previously card-registered skills no longer on the card — but
 *              NEVER a yaml override (those are declared intent in agents.yaml /
 *              agents.d and persist regardless of what the card advertises).
 *
 * Pure so the override-preservation invariant is unit-testable without the
 * network. `previousCard`/`currentCard` are card-discovered sets only; yaml
 * overrides are tracked separately and registered once at agent registration.
 */
export function reconcileCardSkills(
  previousCard: Set<string>,
  yamlOverrides: Set<string>,
  currentCard: Set<string>,
): { toAdd: string[]; toRemove: string[] } {
  const toAdd: string[] = [];
  for (const s of currentCard) {
    if (!previousCard.has(s) && !yamlOverrides.has(s)) toAdd.push(s);
  }
  const toRemove: string[] = [];
  for (const s of previousCard) {
    if (!currentCard.has(s) && !yamlOverrides.has(s)) toRemove.push(s);
  }
  return { toAdd, toRemove };
}

export class SkillBrokerPlugin implements Plugin {
  readonly name = "skill-broker";
  readonly description = "Registers A2AExecutors with ExecutorRegistry from agents.yaml + auto-discovered agent cards";
  readonly capabilities = ["executor-registrar", "a2a-routing"];

  private readonly workspaceDir: string;
  private readonly executorRegistry: ExecutorRegistry;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  /** Card-discovered skills per agent — the set diffed + pruned on each card refresh. */
  private registeredSkills = new Map<string, Set<string>>();
  /**
   * Yaml-declared skills per agent (the `skills:` block in agents.yaml / agents.d).
   * These are OVERRIDES — they take precedence and are NEVER pruned by card
   * discovery, even when the agent's card doesn't (yet) advertise them. Without
   * this, an agent whose card lags its yaml (e.g. a fresh fork still advertising
   * only `chat`) loses its declared skills on the first 10-min refresh.
   */
  private readonly yamlSkills = new Map<string, Set<string>>();
  /** Per-agent liveness probe cache, refreshed every HEARTBEAT_INTERVAL_MS. */
  private fleetHealth = new Map<string, AgentHealthProbe>();
  /** Live A2A agent set (def + executor) — the source for timers + control-plane reconcile. */
  private readonly agentDefs = new Map<string, AgentDef>();
  private readonly executors = new Map<string, A2AExecutor>();
  private bus?: EventBus;
  private opsChannel = "";

  constructor(workspaceDir: string, executorRegistry: ExecutorRegistry) {
    this.workspaceDir = workspaceDir;
    this.executorRegistry = executorRegistry;
  }

  /**
   * Fleet liveness snapshot. One entry per A2A agent registered at install.
   * `/api/agent-health` merges this with ExecutorRegistry to surface both
   * "what skills are wired" and "is the agent actually reachable right now".
   */
  getFleetHealth(): AgentHealthProbe[] {
    return Array.from(this.fleetHealth.values());
  }

  install(bus: EventBus): void {
    this.bus = bus;
    this.opsChannel = process.env.DISCORD_AGENT_OPS_CHANNEL ?? "";

    for (const agent of this._loadAgents()) this._registerAgent(agent);
    console.log(`[skill-broker] Registered ${this.agentDefs.size} A2A agent(s) (skills from yaml + agents.d/; discovery in progress)`);

    // Control-plane (ADR-0004 P3): live add/remove of A2A agents. The registrar
    // persists the entry to workspace/agents.d/; we register/unregister the
    // executor in the same bus turn, so the change is live without a restart.
    bus.subscribe("command.a2a.upsert", this.name, (msg: BusMessage) => {
      const entry = (msg.payload as { entry?: AgentDef })?.entry;
      if (entry?.name && entry.url) this._registerAgent(entry);
    });
    bus.subscribe("command.a2a.remove", this.name, (msg: BusMessage) => {
      const name = (msg.payload as { name?: string })?.name;
      if (name) this._unregisterAgent(name);
    });

    // Periodic skill rediscovery + liveness heartbeat — over the LIVE set, so
    // control-plane-added agents are refreshed/probed too.
    this.refreshTimer = setInterval(() => {
      for (const [name, agent] of this.agentDefs) {
        const executor = this.executors.get(name);
        if (executor) void this._discoverSkills(agent, executor, resolveEnvVars(agent.url, "skill-broker"));
      }
    }, CARD_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();

    this.heartbeatTimer = setInterval(() => {
      for (const agent of this.agentDefs.values()) void this._probeAgentHealth(agent, resolveEnvVars(agent.url, "skill-broker"));
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    for (const agent of this.agentDefs.values()) void this._probeAgentHealth(agent, resolveEnvVars(agent.url, "skill-broker"));
  }

  /** Create + register an A2A agent's executor. Idempotent — re-registers cleanly if the name already exists. */
  private _registerAgent(agent: AgentDef): void {
    if (this.agentDefs.has(agent.name)) this._unregisterAgent(agent.name);
    const bus = this.bus;
    const opsChannel = this.opsChannel;
    const resolvedUrl = resolveEnvVars(agent.url, "skill-broker");
    const executor = new A2AExecutor({
      name: agent.name,
      url: resolvedUrl,
      apiKeyEnv: agent.apiKeyEnv,
      auth: agent.auth,
      extraHeaders: agent.headers,
      streaming: agent.streaming ?? false,
      external: agent.external ?? false,
      onStreamUpdate: opsChannel && bus
        ? (update) => {
            bus.publish(`message.outbound.discord.push.${opsChannel}`, {
              id: crypto.randomUUID(),
              correlationId: crypto.randomUUID(),
              topic: `message.outbound.discord.push.${opsChannel}`,
              timestamp: Date.now(),
              payload: { content: `**${agent.name}** [${update.state ?? update.type}] ${(update.text ?? "").slice(0, 300)}` },
            });
          }
        : undefined,
    });

    const explicitSkills = new Set<string>();
    for (const s of agent.skills ?? []) {
      const skillName = typeof s === "string" ? s : s.name;
      this.executorRegistry.register(skillName, executor, { agentName: agent.name, priority: 5 });
      explicitSkills.add(skillName);
    }
    // Yaml skills are overrides — record them separately so card discovery never
    // prunes them. registeredSkills only ever tracks card-discovered skills.
    this.yamlSkills.set(agent.name, explicitSkills);
    this.registeredSkills.set(agent.name, new Set());
    this.agentDefs.set(agent.name, agent);
    this.executors.set(agent.name, executor);
    void this._discoverSkills(agent, executor, resolvedUrl);
    void this._probeAgentHealth(agent, resolvedUrl);
  }

  /** Unregister an A2A agent and every skill it owns. */
  private _unregisterAgent(name: string): void {
    // Sweep ALL registrations for this agent (yaml + discovered), not just the tracked set.
    for (const reg of this.executorRegistry.list()) {
      if (reg.agentName === name && reg.skill) this.executorRegistry.unregister(reg.skill, name);
    }
    this.registeredSkills.delete(name);
    this.yamlSkills.delete(name);
    this.agentDefs.delete(name);
    this.executors.delete(name);
    this.fleetHealth.delete(name);
    console.log(`[skill-broker] - A2A agent "${name}" unregistered`);
  }

  uninstall(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  /**
   * Single-agent liveness probe. Fetches the agent card with a 3s timeout
   * and records reachability + latency. Also mirrors the discovery side-
   * effect of updating the executor's capability flags so heartbeat and
   * discovery converge to the same truth.
   *
   * Never throws — bad fetches just produce a `reachable: false` probe
   * entry. `/api/agent-health` surfaces the error for the operator.
   */
  private async _probeAgentHealth(agent: AgentDef, url: string): Promise<void> {
    const startedAt = Date.now();
    const probe: AgentHealthProbe = {
      agentName: agent.name,
      url,
      reachable: false,
      lastProbedAt: startedAt,
    };

    try {
      const card = await this._fetchCard(url);
      const elapsed = Date.now() - startedAt;
      if (card) {
        probe.reachable = true;
        probe.cardAvailable = true;
        probe.latencyMs = elapsed;
        probe.streaming = card.capabilities?.streaming === true;
        probe.pushNotifications = card.capabilities?.pushNotifications === true;
        probe.skillCount = (card.skills ?? []).length;
      } else {
        probe.error = "card fetch returned null (agent unreachable or malformed card)";
      }
    } catch (err) {
      probe.latencyMs = Date.now() - startedAt;
      probe.error = err instanceof Error ? err.message : String(err);
    }

    this.fleetHealth.set(agent.name, probe);
  }

  /**
   * Fetch the agent card and register any skills not already in yaml.
   * Silent failure — card fetch errors are logged but don't break the broker.
   */
  private async _discoverSkills(agent: AgentDef, executor: A2AExecutor, url: string): Promise<void> {
    try {
      const card = await this._fetchCard(url);
      if (!card) return;

      // Refresh transport capability flags from the card — authoritative source
      // for streaming + push-notifications. Without this, executors keep using
      // the yaml bootstrap value even when the agent has changed its
      // advertisement. Cost: one setter call per agent per refresh cycle.
      const caps = card.capabilities ?? {};
      const priorStreaming = executor.streaming;
      const priorPush = executor.pushNotifications;
      executor.setCapabilities({
        streaming: caps.streaming === true,
        pushNotifications: caps.pushNotifications === true,
      });
      if (priorStreaming !== executor.streaming || priorPush !== executor.pushNotifications) {
        console.log(
          `[skill-broker] ${agent.name}: capabilities updated — streaming=${executor.streaming} pushNotifications=${executor.pushNotifications}`,
        );
      }

      // registeredSkills tracks only CARD-discovered skills (yaml overrides live
      // in yamlSkills and are never pruned here).
      const previouslyRegistered = this.registeredSkills.get(agent.name) ?? new Set<string>();
      const yamlOverrides = this.yamlSkills.get(agent.name) ?? new Set<string>();
      const currentSkills = new Set<string>();
      for (const cardSkill of card.skills ?? []) {
        if (cardSkill.id) currentSkills.add(cardSkill.id);
      }

      const { toAdd, toRemove } = reconcileCardSkills(previouslyRegistered, yamlOverrides, currentSkills);
      for (const skillName of toAdd) {
        this.executorRegistry.register(skillName, executor, { agentName: agent.name, priority: 5 });
      }
      for (const skillName of toRemove) {
        this.executorRegistry.unregister(skillName, agent.name);
      }
      const added = toAdd.length;
      const removed = toRemove;

      this.registeredSkills.set(agent.name, currentSkills);
      if (added > 0) {
        console.log(
          `[skill-broker] ${agent.name}: discovered ${added} new skill(s) from agent card (${Array.from(currentSkills).join(", ")})`,
        );
      }
      if (removed.length > 0) {
        console.warn(
          `[skill-broker] ${agent.name}: removed ${removed.length} skill(s) no longer in agent card — ${removed.join(", ")}`,
        );
      }

      this._loadHitlModeDeclarations(agent.name, card);
      this._loadBlastDeclarations(agent.name, card);
    } catch (err) {
      // console.debug here would silently swallow real card-discovery
      // bugs — see #593 where weeks of zero-skill agents went unnoticed.
      // Warn at the operator surface so the failure shows up in the same
      // place as the rest of the broker's per-agent lifecycle logs.
      console.warn(
        `[skill-broker] ${agent.name}: card discovery failed — ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Parse `capabilities.extensions[hitl-mode-v1].params.skills` and populate
   * the shared HITL-mode registry. Clears the agent's prior entries first so
   * deletions on the agent's card propagate through.
   */
  private _loadHitlModeDeclarations(agentName: string, card: AgentCard): void {
    defaultHitlModeRegistry.clearAgent(agentName);

    const ext = (card.capabilities?.extensions ?? []).find(e => e?.uri === HITL_MODE_URI);
    if (!ext) return;

    const params = (ext.params ?? {}) as { skills?: Record<string, unknown> };
    const entries = params.skills && typeof params.skills === "object" ? params.skills : {};
    let declared = 0;

    for (const [skill, rawEntry] of Object.entries(entries)) {
      const entry = rawEntry as { mode?: unknown; vetoTtlMs?: unknown; reviewer?: unknown; note?: unknown } | undefined;
      if (!entry || typeof entry !== "object") continue;
      const mode = entry.mode;
      if (typeof mode !== "string") continue;
      if (!["autonomous", "notification", "veto", "gated", "compound"].includes(mode)) continue;

      defaultHitlModeRegistry.declare({
        agentName,
        skill,
        mode: mode as HitlMode,
        ...(typeof entry.vetoTtlMs === "number" ? { vetoTtlMs: entry.vetoTtlMs } : {}),
        ...(entry.reviewer === "operator" ? { reviewer: "operator" as const } : {}),
        ...(typeof entry.note === "string" ? { note: entry.note } : {}),
      });
      declared++;
    }

    if (declared > 0) {
      console.log(`[skill-broker] ${agentName}: loaded ${declared} hitl-mode declaration(s)`);
    }
  }

  private _loadBlastDeclarations(agentName: string, card: AgentCard): void {
    defaultBlastRegistry.clearAgent(agentName);

    const ext = (card.capabilities?.extensions ?? []).find(e => e?.uri === BLAST_URI);
    if (!ext) return;

    const params = (ext.params ?? {}) as { skills?: Record<string, unknown> };
    const entries = params.skills && typeof params.skills === "object" ? params.skills : {};
    const validRadii = new Set(["self", "project", "repo", "fleet", "public"]);
    let declared = 0;

    for (const [skill, rawEntry] of Object.entries(entries)) {
      const entry = rawEntry as { radius?: unknown; note?: unknown } | undefined;
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.radius !== "string" || !validRadii.has(entry.radius)) continue;

      defaultBlastRegistry.declare({
        agentName,
        skill,
        radius: entry.radius as BlastRadius,
        ...(typeof entry.note === "string" ? { note: entry.note } : {}),
      });
      declared++;
    }

    if (declared > 0) {
      console.log(`[skill-broker] ${agentName}: loaded ${declared} blast declaration(s)`);
    }
  }

  private async _fetchCard(url: string): Promise<AgentCard | null> {
    const baseUrl = url.replace(/\/a2a\/?$/, "");
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory()],
    });
    let primaryErr: unknown;
    try {
      const client = await factory.createFromUrl(baseUrl);
      return await client.getAgentCard();
    } catch (err) {
      primaryErr = err;
    }
    // Try legacy /.well-known/agent.json before giving up.
    try {
      const client = await factory.createFromUrl(baseUrl, "/.well-known/agent.json");
      return await client.getAgentCard();
    } catch (legacyErr) {
      // Both failed — surface the failure loudly. Quiet `return null` here
      // is what made #593 invisible for weeks: agents register no skills,
      // every downstream chat_with_agent call 404s, and the operator sees
      // nothing in stdout until they happen to inspect /api/agents/runtime.
      // Per feedback_fail_fast_and_loud — fail loud at the boundary.
      const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const legacyMsg = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
      console.warn(
        `[skill-broker] Failed to fetch agent card from ${baseUrl}: ` +
          `primary path → ${primaryMsg}; legacy /.well-known/agent.json → ${legacyMsg}`,
      );
      return null;
    }
  }

  /**
   * Resolve the agent registry from one of two sources:
   *
   *   1. PROTOLABS_AGENTS_JSON env var — if set, parsed as JSON `{ agents: [...] }`.
   *      Lets Infisical-backed deployments ship the entire registry through
   *      a single secret without needing a file on disk.
   *
   *   2. workspace/agents.yaml — file on disk. The committed default covers
   *      our standard fleet (Quinn, Jon, Researcher, Frank, protopen);
   *      per-host overrides work by editing the file locally.
   *
   * If both are present, the env var wins. If neither resolves to a valid
   * list, the broker registers zero external agents and logs a warning.
   */
  private _loadBaseAgents(): AgentDef[] {
    // Try the env-var path first — deployments use this to avoid file state
    const envOverride = process.env.PROTOLABS_AGENTS_JSON;
    if (envOverride && envOverride.trim()) {
      try {
        const parsed = JSON.parse(envOverride) as { agents?: AgentDef[] };
        if (Array.isArray(parsed.agents)) {
          console.log(`[skill-broker] Loaded ${parsed.agents.length} agent(s) from PROTOLABS_AGENTS_JSON`);
          return parsed.agents;
        }
        console.warn("[skill-broker] PROTOLABS_AGENTS_JSON parsed but has no `agents` array — falling back to yaml");
      } catch (err) {
        console.error("[skill-broker] Failed to parse PROTOLABS_AGENTS_JSON — falling back to yaml:", err);
      }
    }

    // File path — committed default
    const agentsPath = join(this.workspaceDir, "agents.yaml");
    if (!existsSync(agentsPath)) {
      console.warn("[skill-broker] agents.yaml not found and PROTOLABS_AGENTS_JSON unset — no A2A agents registered");
      return [];
    }
    try {
      const raw = readFileSync(agentsPath, "utf8");
      const parsed = parseYaml(raw) as { agents?: AgentDef[] };
      return parsed.agents ?? [];
    } catch (err) {
      console.error("[skill-broker] Failed to load agents.yaml:", err);
      return [];
    }
  }

  /**
   * Control-plane-managed A2A entries (ADR-0004 P3): one AgentDef per file in
   * workspace/agents.d/. Kept separate from the hand-maintained, comment-rich
   * agents.yaml so writes never clobber its docs.
   */
  private _loadAgentsDir(): AgentDef[] {
    const dir = join(this.workspaceDir, "agents.d");
    if (!existsSync(dir)) return [];
    const out: AgentDef[] = [];
    try {
      for (const f of readdirSync(dir)) {
        if (!(f.endsWith(".yaml") || f.endsWith(".yml")) || f.endsWith(".example")) continue;
        try {
          const def = parseYaml(readFileSync(join(dir, f), "utf8")) as AgentDef;
          if (def?.name && def.url) out.push(def);
          else console.warn(`[skill-broker] agents.d/${f}: missing name/url — skipped`);
        } catch (err) {
          console.error(`[skill-broker] Skipping agents.d/${f}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch { /* dir vanished mid-scan */ }
    return out;
  }

  /** agents.yaml (or PROTOLABS_AGENTS_JSON) merged with control-plane agents.d/, deduped by name (managed wins). */
  private _loadAgents(): AgentDef[] {
    const byName = new Map<string, AgentDef>();
    for (const a of this._loadBaseAgents()) byName.set(a.name, a);
    for (const a of this._loadAgentsDir()) byName.set(a.name, a);
    return [...byName.values()];
  }
}

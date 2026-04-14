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

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import type { AgentCard } from "@a2a-js/sdk";
import type { Plugin, EventBus } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import { A2AExecutor } from "../executor/executors/a2a-executor.ts";
import { resolveEnvVars } from "../utils/env-interpolation.ts";

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
  skills?: Array<AgentSkill | string>;
}

const CARD_REFRESH_INTERVAL_MS = 10 * 60_000; // 10 min

export class SkillBrokerPlugin implements Plugin {
  readonly name = "skill-broker";
  readonly description = "Registers A2AExecutors with ExecutorRegistry from agents.yaml + auto-discovered agent cards";
  readonly capabilities = ["executor-registrar", "a2a-routing"];

  private readonly workspaceDir: string;
  private readonly executorRegistry: ExecutorRegistry;
  private refreshTimer?: ReturnType<typeof setInterval>;
  /** Tracks skills we registered per agent so we can cleanly re-register on refresh. */
  private registeredSkills = new Map<string, Set<string>>();

  constructor(workspaceDir: string, executorRegistry: ExecutorRegistry) {
    this.workspaceDir = workspaceDir;
    this.executorRegistry = executorRegistry;
  }

  install(bus: EventBus): void {
    const agents = this._loadAgents();
    const opsChannel = process.env.DISCORD_AGENT_OPS_CHANNEL ?? "";

    for (const agent of agents) {
      const resolvedUrl = resolveEnvVars(agent.url, "skill-broker");
      const executor = new A2AExecutor({
        name: agent.name,
        url: resolvedUrl,
        apiKeyEnv: agent.apiKeyEnv,
        auth: agent.auth,
        extraHeaders: agent.headers,
        streaming: agent.streaming ?? false,
        onStreamUpdate: opsChannel
          ? (update) => {
              bus.publish(`message.outbound.discord.push.${opsChannel}`, {
                id: crypto.randomUUID(),
                correlationId: crypto.randomUUID(),
                topic: `message.outbound.discord.push.${opsChannel}`,
                timestamp: Date.now(),
                payload: {
                  content: `**${agent.name}** [${update.state ?? update.type}] ${(update.text ?? "").slice(0, 300)}`,
                },
              });
            }
          : undefined,
      });

      // Register yaml-declared skills synchronously (explicit overrides)
      const explicitSkills = new Set<string>();
      for (const s of agent.skills ?? []) {
        const skillName = typeof s === "string" ? s : s.name;
        this.executorRegistry.register(skillName, executor, {
          agentName: agent.name,
          priority: 5,
        });
        explicitSkills.add(skillName);
      }
      this.registeredSkills.set(agent.name, explicitSkills);

      // Kick off async card discovery for any skills not in yaml
      void this._discoverSkills(agent, executor, resolvedUrl);
    }

    console.log(`[skill-broker] Registered ${agents.length} A2A agent(s) (skills from yaml; discovery in progress)`);

    // Periodic refresh — picks up new skills without a restart
    this.refreshTimer = setInterval(() => {
      for (const agent of agents) {
        const executor = this.executorRegistry.list().find(r => r.agentName === agent.name)?.executor;
        if (executor && executor.type === "a2a") {
          void this._discoverSkills(agent, executor as A2AExecutor, resolveEnvVars(agent.url, "skill-broker"));
        }
      }
    }, CARD_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  uninstall(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
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

      const registered = this.registeredSkills.get(agent.name) ?? new Set();
      let added = 0;

      for (const cardSkill of card.skills ?? []) {
        const skillName = cardSkill.id;
        if (!skillName || registered.has(skillName)) continue;

        this.executorRegistry.register(skillName, executor, {
          agentName: agent.name,
          priority: 5,
        });
        registered.add(skillName);
        added++;
      }

      this.registeredSkills.set(agent.name, registered);
      if (added > 0) {
        console.log(`[skill-broker] ${agent.name}: discovered ${added} new skill(s) from agent card (${Array.from(registered).join(", ")})`);
      }
    } catch (err) {
      console.debug(`[skill-broker] ${agent.name}: card discovery skipped:`, err instanceof Error ? err.message : err);
    }
  }

  private async _fetchCard(url: string): Promise<AgentCard | null> {
    const baseUrl = url.replace(/\/a2a\/?$/, "");
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory()],
    });
    try {
      const client = await factory.createFromUrl(baseUrl);
      return await client.getAgentCard();
    } catch {
      // Try legacy path
      try {
        const client = await factory.createFromUrl(baseUrl, "/.well-known/agent.json");
        return await client.getAgentCard();
      } catch {
        return null;
      }
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
  private _loadAgents(): AgentDef[] {
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
}

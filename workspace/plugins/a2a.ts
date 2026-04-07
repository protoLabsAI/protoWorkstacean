/**
 * A2APlugin — skill-based routing from Workstacean bus → A2A agent fleet.
 *
 * Inbound messages are matched to a skill, routed to the appropriate agent,
 * and the response published back to the bus. Chain config in agents.yaml
 * enables sequential agent pipelines (e.g. quinn/bug_triage → ava/manage_feature).
 *
 * Config: workspace/agents.yaml
 *
 * Env vars:
 *   AGENTS_YAML    path to agent registry (default: /workspace/agents.yaml)
 *   AVA_API_KEY    API key for Ava's /a2a endpoint
 *   GITHUB_TOKEN   posts chained agent responses as GitHub comments
 */

import { readFileSync, watchFile, unwatchFile } from "node:fs";
import { createSign } from "node:crypto";
import { parse } from "yaml";

// ── GitHub App auth ───────────────────────────────────────────────────────────
// Ava posts chain responses as ava[bot] using her own App identity.

class GitHubAppAuth {
  private cache = new Map<string, { token: string; exp: number }>();

  constructor(private appId: string, private privateKey: string) {}

  async getToken(owner: string, repo: string): Promise<string> {
    const key = `${owner}/${repo}`;
    const cached = this.cache.get(key);
    if (cached && cached.exp > Date.now() + 60_000) return cached.token;

    const jwt = this.makeJWT();
    const headers = this.appHeaders(jwt);

    const installResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/installation`,
      { headers },
    );
    if (!installResp.ok) throw new Error(`App not installed on ${owner}/${repo}: ${installResp.status}`);
    const { id: installId } = await installResp.json() as { id: number };

    const tokenResp = await fetch(
      `https://api.github.com/app/installations/${installId}/access_tokens`,
      { method: "POST", headers },
    );
    if (!tokenResp.ok) throw new Error(`Token fetch failed: ${tokenResp.status}`);
    const { token, expires_at } = await tokenResp.json() as { token: string; expires_at: string };

    this.cache.set(key, { token, exp: new Date(expires_at).getTime() });
    return token;
  }

  private makeJWT(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: this.appId })).toString("base64url");
    const data = `${header}.${payload}`;
    const sig = createSign("RSA-SHA256").update(data).sign(this.privateKey, "base64url");
    return `${data}.${sig}`;
  }

  private appHeaders(jwt: string): Record<string, string> {
    return {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "protoWorkstacean/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }
}

let _avaApp: GitHubAppAuth | null | undefined;

function getAvaApp(): GitHubAppAuth | null {
  if (_avaApp !== undefined) return _avaApp;
  const appId = process.env.AVA_APP_ID;
  const privateKey = process.env.AVA_APP_PRIVATE_KEY;
  _avaApp = appId && privateKey ? new GitHubAppAuth(appId, privateKey) : null;
  return _avaApp;
}

async function resolveAvaToken(owner: string, repo: string): Promise<string> {
  const app = getAvaApp();
  if (app) {
    try { return await app.getToken(owner, repo); }
    catch (err) { console.error("[a2a] App auth failed, falling back to PAT:", err); }
  }
  const pat = process.env.GITHUB_TOKEN;
  if (pat) return pat;
  throw new Error("No GitHub auth configured (AVA_APP_ID or GITHUB_TOKEN required)");
}

// ── Types ───────────────────────────────────────────────────────────────────

// Mirrors lib/types.ts from protoWorkstacean — kept inline since workspace
// plugins are dynamically loaded and can't import from the host package.
interface BusMessageSource {
  interface: "discord" | "slack" | "voice" | "github" | "plane" | "api" | string;
  channelId?: string;
  userId?: string;
}

interface BusMessage {
  id: string;
  correlationId: string;
  topic: string;
  timestamp: number;
  payload: unknown;
  source?: BusMessageSource;
  reply?: { topic: string; format?: string };
}

interface EventBus {
  publish(topic: string, message: BusMessage): void;
  subscribe(pattern: string, pluginName: string, handler: (msg: BusMessage) => void | Promise<void>): string;
}

interface AgentDef {
  name: string;
  url: string;
  apiKeyEnv?: string;
  skills: string[];
  chain?: Record<string, string | { agent: string; prompt?: string }>; // skill → agent name or {agent, prompt}
}

interface AgentCard {
  name: string;
  skills?: { id: string; name: string; tags?: string[] }[];
}

interface GitHubContext {
  owner: string;
  repo: string;
  number: number;
  url?: string;
}

// ── Agent registry ──────────────────────────────────────────────────────────

const AGENTS_YAML = process.env.AGENTS_YAML ?? "/workspace/agents.yaml";

function loadAgents(): AgentDef[] {
  try {
    const raw = readFileSync(AGENTS_YAML, "utf-8");
    const cfg = parse(raw) as { agents?: AgentDef[] };
    return cfg.agents ?? [];
  } catch (e) {
    console.error("[a2a] Failed to load agents.yaml:", e);
    return [];
  }
}

async function refreshSkills(agents: AgentDef[]): Promise<void> {
  for (const agent of agents) {
    try {
      const base = agent.url.replace(/\/a2a$/, "");
      const resp = await fetch(`${base}/.well-known/agent.json`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) continue;
      const card = (await resp.json()) as AgentCard;
      if (card.skills?.length) {
        agent.skills = card.skills.map(s => s.id);
        console.log(`[a2a] ${agent.name} skills: ${agent.skills.join(", ")}`);
      }
    } catch {
      // agent offline — keep yaml-defined skills
    }
  }
}

// ── Skill matching ──────────────────────────────────────────────────────────

const SKILL_KEYWORDS: Record<string, string[]> = {
  // Quinn
  bug_triage:   ["bug", "issue", "broken", "crash", "error", "fail", "exception", "triage", "TypeError", "ReferenceError", "📋"],
  qa_report:    ["report", "qa", "digest", "quality", "/report"],
  board_audit:  ["audit", "board", "backlog", "sprint", "features", "/audit"],
  pr_review:    ["pr", "pull request", "review", "merge", "ci", "/review"],
  // Ava
  plan:           ["build", "create feature", "new feature", "idea:", "let's build", "plan:", "i want to"],
  plan_resume:    ["approve", "reject", "modify"],
  sitrep:         ["status", "sitrep", "situation", "what's up", "summary", "/status", "/sitrep"],
  manage_feature: ["unblock", "assign", "move to", "add to board"],
  board_health:   ["blocked", "stalled", "stuck", "health", "unhealthy"],
  auto_mode:      ["auto mode", "start auto", "stop auto", "pause auto"],
  // Memory (handled locally by workstacean — never forwarded to an agent)
  memory_recall:  ["remember", "recall", "what do you know about", "memory search", "/recall"],
  memory_store:   ["memorize", "save this", "remember this", "store this", "/memorize"],
};

function matchSkill(content: string, hint?: string): string | null {
  if (hint) return hint;
  const lower = content.toLowerCase();
  for (const [skill, keywords] of Object.entries(SKILL_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw.toLowerCase()))) return skill;
  }
  return null;
}

function routeToAgent(skill: string | null, agents: AgentDef[]): AgentDef {
  if (skill) {
    const match = agents.find(a => a.skills.includes(skill));
    if (match) return match;
  }
  // Default: Ava (Chief of Staff — she delegates further)
  return agents.find(a => a.name === "ava") ?? agents[0];
}

// ── A2A protocol ────────────────────────────────────────────────────────────

async function callA2A(
  agent: AgentDef,
  content: string,
  contextId: string,
  skillHint?: string,
  source?: BusMessageSource,
  replyTopic?: string,
  extraMeta?: Record<string, unknown>,
): Promise<string> {
  const apiKey = agent.apiKeyEnv ? (process.env[agent.apiKeyEnv] ?? "") : "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const metadata: Record<string, unknown> = { ...(extraMeta ?? {}) };
  if (skillHint) metadata.skillHint = skillHint;
  if (source) metadata.source = source;
  if (replyTopic) metadata.replyTopic = replyTopic;

  const resp = await fetch(agent.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: {
        message: { role: "user", parts: [{ kind: "text", text: content }] },
        contextId,
        ...(Object.keys(metadata).length ? { metadata } : {}),
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const data = (await resp.json()) as {
    result?: { artifacts?: { parts?: { kind: string; text?: string }[] }[] };
    error?: { message: string };
  };

  if (data.error) throw new Error(data.error.message);

  return (data.result?.artifacts ?? [])
    .flatMap(a => a.parts ?? [])
    .filter(p => p.kind === "text")
    .map(p => p.text ?? "")
    .join("\n") || "(no response)";
}

// ── Output helpers ──────────────────────────────────────────────────────────

function publishResponse(bus: EventBus, topic: string, correlationId: string, content: string, channel: unknown, agentId?: string): void {
  bus.publish(topic, {
    id: crypto.randomUUID(),
    correlationId,
    topic,
    timestamp: Date.now(),
    payload: { content, channel, ...(agentId ? { agentId } : {}) },
  });
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "protoWorkstacean/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function postGitHubComment(gh: GitHubContext, body: string): Promise<void> {
  const token = await resolveAvaToken(gh.owner, gh.repo);
  const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/issues/${gh.number}/comments`;
  const res = await fetch(url, { method: "POST", headers: githubHeaders(token), body: JSON.stringify({ body }) });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
}

// Fire-and-forget — best-effort acknowledgement, never throws.
function reactToGitHubIssue(gh: GitHubContext, reaction: string): void {
  const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/issues/${gh.number}/reactions`;
  resolveAvaToken(gh.owner, gh.repo)
    .then(token => fetch(url, { method: "POST", headers: githubHeaders(token), body: JSON.stringify({ content: reaction }) }))
    .then(res => {
      if (res.ok) console.log(`[a2a] reacted :${reaction}: on ${gh.owner}/${gh.repo}#${gh.number}`);
      else res.text().then(t => console.error(`[a2a] reaction failed ${res.status}: ${t}`));
    })
    .catch(err => console.error("[a2a] reaction error:", err));
}

// ── Local memory skill handler ───────────────────────────────────────────────

const MEMORY_SKILLS = new Set(["memory_recall", "memory_store"]);

async function handleMemorySkill(
  bus: EventBus,
  skill: string,
  content: string,
  msg: BusMessage,
  outboundTopic: string,
  p: Record<string, unknown>,
): Promise<void> {
  const userId = (p.userId as string | undefined) ?? msg.source?.userId ?? "default";

  if (skill === "memory_store") {
    bus.publish("memory.add", {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: "memory.add",
      timestamp: Date.now(),
      payload: {
        userId,
        messages: [{ role: "user", content }],
      },
    });
    publishResponse(bus, outboundTopic, msg.correlationId, "✓ Stored in memory.", p.channel);
    return;
  }

  // memory_recall — query and await result via one-shot reply subscription
  const replyTopic = `memory.result.${crypto.randomUUID()}`;

  const result = await new Promise<string>((resolve) => {
    const subId = bus.subscribe(replyTopic, "a2a-memory", (reply: BusMessage) => {
      bus.unsubscribe(subId);
      const r = reply.payload as { memories?: { memory: string; score?: number }[]; error?: string };
      if (r.error) { resolve(`⚠️ Memory error: ${r.error}`); return; }
      const items = r.memories ?? [];
      if (!items.length) { resolve("(no relevant memories found)"); return; }
      resolve(items.map((m, i) => `${i + 1}. ${m.memory}`).join("\n"));
    });

    bus.publish("memory.search", {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: "memory.search",
      timestamp: Date.now(),
      payload: { userId, query: content, limit: 5 },
      reply: { topic: replyTopic },
    });

    // Timeout after 10s
    setTimeout(() => {
      bus.unsubscribe(subId);
      resolve("(memory search timed out)");
    }, 10_000);
  });

  publishResponse(bus, outboundTopic, msg.correlationId, result, p.channel);
}

// ── Chain execution ─────────────────────────────────────────────────────────

async function runChain(
  bus: EventBus,
  agents: AgentDef[],
  fromAgent: AgentDef,
  skill: string,
  originalContent: string,
  firstResponse: string,
  outboundTopic: string,
  channel: unknown,
  gh?: GitHubContext,
): Promise<void> {
  const chainEntry = fromAgent.chain?.[skill];
  if (!chainEntry) return;

  const nextAgentName = typeof chainEntry === "string" ? chainEntry : chainEntry.agent;
  const chainPromptSuffix = typeof chainEntry === "string" ? "" : (chainEntry.prompt ?? "");

  const nextAgent = agents.find(a => a.name === nextAgentName);
  if (!nextAgent) {
    console.error(`[a2a] chain: agent "${nextAgentName}" not found in registry`);
    return;
  }

  const githubPrefix = gh
    ? `GitHub: ${gh.owner}/${gh.repo}#${gh.number}${gh.url ? ` — ${gh.url}` : ""}\n\n`
    : "";
  const prompt = [
    `${githubPrefix}${fromAgent.name} completed ${skill.replace(/_/g, " ")} and responded:\n\n${firstResponse}\n\nOriginal report:\n${originalContent}`,
    chainPromptSuffix,
  ].filter(Boolean).join("\n\n");

  // Signal Ava is picking up Quinn's work — eyes on the issue before we call her
  if (gh) reactToGitHubIssue(gh, "eyes");

  console.log(`[a2a] chain: ${fromAgent.name} → ${nextAgent.name}`);
  const response = await callA2A(nextAgent, prompt, `workstacean-chain-${fromAgent.name}-${nextAgent.name}`);

  if (gh && process.env.GITHUB_TOKEN) {
    await postGitHubComment(gh, response);
    console.log(`[a2a] chain: ${nextAgent.name} comment posted to ${gh.owner}/${gh.repo}#${gh.number}`);
  } else {
    publishResponse(bus, outboundTopic, crypto.randomUUID(), response, channel, nextAgent.name);
  }
}

// ── Skills handled locally (never forwarded to an external agent) ────────────

const LOCAL_SKILLS = new Set(["memory_recall", "memory_store", "onboard_project"]);

// ── Plugin ──────────────────────────────────────────────────────────────────

export default {
  name: "a2a",
  description: "Skill-based A2A routing to the protoLabs agent fleet",
  capabilities: ["a2a-routing"],

  install(bus: EventBus) {
    let agents = loadAgents();

    if (!agents.length) {
      console.error("[a2a] No agents loaded — check workspace/agents.yaml");
      return;
    }

    console.log(`[a2a] Loaded ${agents.length} agents: ${agents.map(a => a.name).join(", ")}`);
    refreshSkills(agents).catch(console.error);

    // ── Hot-reload agents.yaml ─────────────────────────────────────────────
    watchFile(AGENTS_YAML, { interval: 5_000 }, () => {
      const updated = loadAgents();
      if (updated.length) {
        agents = updated;
        console.log(`[a2a] agents.yaml reloaded — ${agents.length} agent(s): ${agents.map(a => a.name).join(", ")}`);
        refreshSkills(agents).catch(console.error);
      } else {
        console.warn("[a2a] agents.yaml reload produced no agents — keeping previous registry");
      }
    });

    // ── Inbound messages ──────────────────────────────────────────────────
    bus.subscribe("message.inbound.#", "a2a", async (msg: BusMessage) => {
      // Skip topics handled by local plugins to prevent routing loops.
      // message.inbound.onboard is consumed by OnboardingPlugin — if a2a
      // re-published to it the handler would fire again, creating an infinite loop.
      if (msg.topic === "message.inbound.onboard" || msg.topic.startsWith("message.inbound.onboard.")) return;

      const p = msg.payload as Record<string, unknown>;
      const content = String(p.content ?? "").trim();
      if (!content) return;

      const channelKey = String(p.channel ?? msg.topic.split(".").slice(2).join("-"));
      const skill = matchSkill(content, p.skillHint as string | undefined);
      const agent = routeToAgent(skill, agents);
      const outboundTopic = msg.reply?.topic
        ?? `message.outbound.${msg.topic.split(".").slice(1).join(".")}`;

      // Memory skills are handled locally — never forwarded to an external agent
      if (skill && MEMORY_SKILLS.has(skill)) {
        console.log(`[a2a] "${content.slice(0, 60)}" → memory (local, skill: ${skill})`);
        await handleMemorySkill(bus, skill, content, msg, outboundTopic, p);
        return;
      }

      // onboard_project: route to OnboardingPlugin via message.inbound.onboard
      if (skill === "onboard_project") {
        console.log(`[a2a] "${content.slice(0, 60)}" → onboarding (local, skill: onboard_project)`);
        const onboardTopic = "message.inbound.onboard";
        bus.publish(onboardTopic, {
          ...msg,
          id: crypto.randomUUID(),
          topic: onboardTopic,
        });
        return;
      }

      console.log(`[a2a] "${content.slice(0, 60)}" → ${agent.name} (skill: ${skill ?? "default"})`);

      // Use the bus message's correlationId when present so Plane reply matching works
      // end-to-end (plane plugin stores pendingIssues keyed by "plane-{issueId}").
      const contextId = msg.correlationId || `workstacean-${channelKey}`;

      // Forward Plane context so the plan skill can update the originating issue
      const planeExtra: Record<string, unknown> = {};
      if (p.planeIssueId) planeExtra.planeIssueId = p.planeIssueId;
      if (p.planeProjectId) planeExtra.planeProjectId = p.planeProjectId;

      try {
        const response = await callA2A(agent, content, contextId, skill ?? undefined, msg.source, outboundTopic, planeExtra);
        publishResponse(bus, outboundTopic, msg.correlationId, response, p.channel, agent.name);

        if (skill && agent.chain?.[skill]) {
          await runChain(bus, agents, agent, skill, content, response, outboundTopic, p.channel, p.github as GitHubContext | undefined);
        }
      } catch (err) {
        console.error(`[a2a] ${agent.name} error:`, err);
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        const errMsg = isTimeout
          ? "I'm still working on that — it's taking longer than expected. Check back in a moment or try again."
          : "I'm having trouble connecting right now. Give me a sec.";
        publishResponse(bus, outboundTopic, msg.correlationId, errMsg, p.channel);
      }
    });

    // ── Cron events ───────────────────────────────────────────────────────
    bus.subscribe("cron.#", "a2a-cron", async (msg: BusMessage) => {
      const p = msg.payload as Record<string, unknown>;
      const content = String(p.content ?? "").trim();
      if (!content) return;

      const cronId = msg.topic.replace("cron.", "");
      const skill = matchSkill(content, p.skillHint as string | undefined);
      const agent = routeToAgent(skill, agents);

      console.log(`[a2a-cron] ${cronId} → ${agent.name}`);

      try {
        const response = await callA2A(agent, content, `workstacean-cron-${cronId}`);
        const channel = String(p.channel ?? "");
        if (channel) {
          publishResponse(bus, `message.outbound.discord.push.${channel}`, msg.correlationId, response, channel, agent.name);
        }
      } catch (err) {
        console.error(`[a2a-cron] ${cronId} error:`, err);
      }
    });
  },

  uninstall(_bus: EventBus) {
    unwatchFile(AGENTS_YAML);
  },
};

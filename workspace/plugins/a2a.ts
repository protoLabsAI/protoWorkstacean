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

function interpolateEnv(value: string): string {
  // agents.yaml uses ${ENV_VAR} syntax for url/apiKeyEnv. The other consumers
  // (skill-broker, domain-discovery) resolve these via a shared helper; this
  // plugin had been reading them raw, which made fetch() choke on literal
  // "${AVA_BASE_URL}/a2a" strings.
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? "");
}

function loadAgents(): AgentDef[] {
  try {
    const raw = readFileSync(AGENTS_YAML, "utf-8");
    const cfg = parse(raw) as { agents?: AgentDef[] };
    const agents = cfg.agents ?? [];
    for (const a of agents) {
      if (typeof a.url === "string") a.url = interpolateEnv(a.url);
    }
    return agents;
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

function routeToAgent(skill: string | null, agents: AgentDef[]): AgentDef | null {
  // Asymmetric fallback semantics — INTENTIONAL, do not "fix" to be symmetric:
  //
  //   explicit-skill + no claimant  → null   (caller skips and logs)
  //   no-skill (free-form content)  → Ava   (Chief-of-Staff default)
  //
  // The split exists because a message with an explicit skill is a routing
  // decision the sender has already made — falling back to a different agent
  // silently misroutes (previously produced pr_review being answered by Ava
  // despite not being in her agent card). But a message with no skill at all
  // is free-form chat, and Ava is the correct default handler for that —
  // she routes it further based on content. Keep the two paths distinct.
  if (skill) {
    const match = agents.find(a => a.skills.includes(skill));
    return match ?? null;
  }
  return agents.find(a => a.name === "ava") ?? agents[0] ?? null;
}

// ── A2A protocol ────────────────────────────────────────────────────────────

// Skills that involve multi-step orchestration (external APIs, agent chains).
// These are dispatched fire-and-forget: workstacean acks immediately and the
// agent posts back to the reply topic when done. No workstacean-side timeout.
const FIRE_AND_FORGET_SKILLS = new Set([
  "onboard_project",  // GitHub + Plane + Discord chain
  "plan",             // SPARC PRD + antagonistic review
  "plan_resume",      // checkpoint restore + feature creation
  "deep_research",    // web + knowledge store traversal
]);

// In-flight guard: tracks currently-running fire-and-forget operations.
// Key: `{agentName}:{skill}:{contentHash}` — prevents duplicate concurrent runs
// when the same trigger fires multiple times (Discord retries, slash command re-click).
// TTL of 10 min covers the longest expected operation.
const inFlightFAF = new Map<string, number>();
const FAF_TTL_MS = 10 * 60 * 1000;

function fafKey(agentName: string, skill: string, content: string): string {
  // Simple hash: agent + skill + first 120 chars of content (enough to distinguish)
  return `${agentName}:${skill}:${content.slice(0, 120)}`;
}

async function callA2A(
  agent: AgentDef,
  content: string,
  contextId: string,
  skillHint?: string,
  source?: BusMessageSource,
  replyTopic?: string,
  extraMeta?: Record<string, unknown>,
  timeoutMs: number | undefined = 120_000,
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
    ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
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
    .join("\n");
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

// ── Locally-owned skill surface ──────────────────────────────────────────────
//
// Single source of truth for which skills this plugin dispatches from the
// `message.inbound.#` subscriber. The inbound handler's guard and the
// downstream branches both read from this set, so there's no way for the
// allowlist to drift from the actual handler logic. Any skill NOT in this
// set falls through to the router + skill-dispatcher canonical path.
//
// When adding a skill to this plugin, add it to one of the source sets
// (MEMORY_SKILLS or FIRE_AND_FORGET_SKILLS) — never hard-code a new string
// here. onboard_project is already covered because it lives in
// FIRE_AND_FORGET_SKILLS.
const LOCALLY_OWNED_SKILLS = new Set<string>([
  ...MEMORY_SKILLS,
  ...FIRE_AND_FORGET_SKILLS,
]);

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

      // Skip messages that already carry an explicit agent target via
      // meta.agentId — those go through skill-dispatcher → A2AExecutor with
      // full projectPath metadata. If this plugin also handles them, both
      // paths fire for the same inbound event, producing the double-triage
      // pattern tracked in protoMaker#3300. The skill-dispatcher is the
      // canonical owner for explicitly-targeted dispatches; this plugin
      // remains the fallback for keyword-matched, untargeted content.
      const meta = p.meta as { agentId?: string } | undefined;
      if (meta?.agentId) return;

      const content = String(p.content ?? "").trim();
      if (!content) return;

      const channelKey = String(p.channel ?? msg.topic.split(".").slice(2).join("-"));
      const skill = matchSkill(content, p.skillHint as string | undefined);
      const outboundTopic = msg.reply?.topic
        ?? `message.outbound.${msg.topic.split(".").slice(1).join(".")}`;

      // ── Local ownership guard ──────────────────────────────────────────────
      // This plugin only handles skills in LOCALLY_OWNED_SKILLS (memory ops +
      // fire-and-forget orchestration, incl. onboard_project). Everything else
      // — including skillHint-tagged webhooks like pr_review from github.ts —
      // is the router + skill-dispatcher pipeline's responsibility. Without
      // this guard the same inbound event triggers *both* plugins and the
      // agent runs twice (observed on protoWorkstacean#104 as paired
      // @protoquinn[bot] review comments).
      //
      // TODO(#75 router-faf-dedup): the router path does NOT skip FAF skills,
      // so onboard_project / plan / plan_resume / deep_research are still
      // double-dispatched today — masked only by the inFlightFAF timing guard
      // below. That mask is race-prone (two fast events can both clear the
      // check before either sets it). Proper fix needs symmetric filters on
      // both sides OR consolidating the ack-immediately pattern into
      // skill-dispatcher so FAF skills can live entirely in the router path.
      if (!skill || !LOCALLY_OWNED_SKILLS.has(skill)) return;

      const agent = routeToAgent(skill, agents);
      if (!agent) {
        // routeToAgent now returns null when an explicit skill has no A2A
        // claimant (was previously silently defaulting to Ava). For locally-
        // owned skills this should never happen — but log it if it does so
        // we don't silently drop.
        console.warn(`[a2a] no registered agent for locally-owned skill "${skill}" — skipping`);
        return;
      }

      // Memory skills are handled locally — never forwarded to an external agent
      if (skill && MEMORY_SKILLS.has(skill)) {
        console.log(`[a2a] "${content.slice(0, 60)}" → memory (local, skill: ${skill})`);
        await handleMemorySkill(bus, skill, content, msg, outboundTopic, p);
        return;
      }

      // onboard_project: route to OnboardingPlugin via message.inbound.onboard.
      // The Discord payload has { content, channel, sender } but OnboardingPlugin
      // expects { slug, title, github }.  Normalise here by parsing the content
      // string for an "owner/repo" token, then building the structured payload.
      // If the format is unrecognisable, reply with a usage error instead of
      // silently dropping — a no-op is worse than a visible failure.
      if (skill === "onboard_project") {
        console.log(`[a2a] "${content.slice(0, 60)}" → onboarding (local, skill: onboard_project)`);

        // Extract the first "owner/repo" token from the raw content string.
        const githubMatch = content.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
        if (!githubMatch) {
          console.warn(`[a2a] onboard_project: no owner/repo found in "${content.slice(0, 80)}"`);
          publishResponse(
            bus,
            outboundTopic,
            msg.correlationId,
            "Usage: `/onboard <owner>/<repo> [slug] [title]`\nExample: `/onboard protolabsai/my-project`",
            p.channel,
            "a2a",
          );
          return;
        }

        const github = githubMatch[1];
        // Derive slug from owner/repo: replace "/" and non-alphanumeric chars with "-"
        const derivedSlug = github.replace(/\//g, "-").replace(/[^A-Za-z0-9-]/g, "-").toLowerCase();
        // Optional explicit slug/title tokens after the repo: "owner/repo my-slug My Title"
        const rest = content.slice(content.indexOf(github) + github.length).trim();
        const restTokens = rest.split(/\s+/).filter(Boolean);
        const slug = restTokens[0] && !restTokens[0].includes("/") ? restTokens[0] : derivedSlug;
        const title = restTokens.length > 1
          ? restTokens.slice(restTokens[0] === slug ? 1 : 0).join(" ")
          : github.split("/")[1].replace(/[-_]/g, " ");

        const onboardTopic = "message.inbound.onboard";
        bus.publish(onboardTopic, {
          ...msg,
          id: crypto.randomUUID(),
          topic: onboardTopic,
          payload: {
            ...p,
            slug,
            title,
            github,
          },
        });
        return;
      }

      console.log(`[a2a] "${content.slice(0, 60)}" → ${agent.name} (skill: ${skill ?? "default"})`);

      // Use the bus message's correlationId when present so Plane reply matching works
      // end-to-end (plane plugin stores pendingIssues keyed by "plane-{issueId}").
      const contextId = msg.correlationId || `workstacean-${channelKey}`;

      // Forward Plane context so the plan skill can update the originating issue.
      // Forward project context so Ava's bug_triage / manage_feature skills
      // have an authoritative projectPath (they refuse to run without it,
      // emitting "metadata.projectPath missing — cannot target project
      // tools without an authoritative path").
      const planeExtra: Record<string, unknown> = {};
      if (p.planeIssueId) planeExtra.planeIssueId = p.planeIssueId;
      if (p.planeProjectId) planeExtra.planeProjectId = p.planeProjectId;
      if (typeof p.projectPath === "string") planeExtra.projectPath = p.projectPath;
      if (typeof p.projectSlug === "string") planeExtra.projectSlug = p.projectSlug;
      if (typeof p.projectRepo === "string") planeExtra.projectRepo = p.projectRepo;
      if (typeof p.prNumber === "number") planeExtra.prNumber = p.prNumber;

      // Fire-and-forget for long-running skills: ack immediately, agent posts
      // back to the reply topic when done. No workstacean-side timeout.
      if (skill && FIRE_AND_FORGET_SKILLS.has(skill)) {
        const key = fafKey(agent.name, skill, content);
        const startedAt = inFlightFAF.get(key);
        const isInFlight = startedAt && (Date.now() - startedAt < FAF_TTL_MS);

        if (isInFlight) {
          console.log(`[a2a] "${skill}" already in-flight — skipping duplicate`);
          publishResponse(bus, outboundTopic, msg.correlationId,
            `⏳ Already working on that — I'll post back when done.`, p.channel);
          return;
        }

        console.log(`[a2a] "${skill}" is fire-and-forget — acking immediately`);
        inFlightFAF.set(key, Date.now());
        publishResponse(bus, outboundTopic, msg.correlationId,
          `⏳ On it — this may take a few minutes. I'll post back when done.`, p.channel);
        callA2A(agent, content, contextId, skill, msg.source, outboundTopic, planeExtra, undefined)
          .then(response => {
            inFlightFAF.delete(key);
            publishResponse(bus, outboundTopic, msg.correlationId, response, p.channel);
            if (agent.chain?.[skill]) {
              runChain(bus, agents, agent, skill, content, response, outboundTopic, p.channel, p.github as GitHubContext | undefined).catch(console.error);
            }
          })
          .catch(err => {
            inFlightFAF.delete(key);
            console.error(`[a2a] ${agent.name} async error:`, err);
            publishResponse(bus, outboundTopic, msg.correlationId,
              `⚠️ ${agent.name} hit an error: ${err instanceof Error ? err.message : String(err)}`, p.channel);
          });
        return;
      }

      try {
        const response = await callA2A(agent, content, contextId, skill ?? undefined, msg.source, outboundTopic, planeExtra);
        publishResponse(bus, outboundTopic, msg.correlationId, response, p.channel, agent.name);

        // If the inbound message carries a devChannelId (e.g. from a /report-bug slash
        // command), also push the full response to that channel so it lands in #dev
        // regardless of where the command was invoked. Same correlationId for e2e tracing.
        const devChannelId = p.devChannelId as string | undefined;
        if (devChannelId) {
          publishResponse(bus, `message.outbound.discord.push.${devChannelId}`, msg.correlationId, response, devChannelId);
        }

        if (skill && agent.chain?.[skill]) {
          await runChain(bus, agents, agent, skill, content, response, outboundTopic, p.channel, p.github as GitHubContext | undefined);
        }
      } catch (err) {
        console.error(`[a2a] ${agent.name} error:`, err);
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        const errMsg = isTimeout
          ? `⏱️ ${agent.name} is still working — check back in a moment or try again.`
          : `⚠️ ${agent.name} encountered an error: ${err instanceof Error ? err.message : String(err)}`;
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
      if (!agent) {
        console.warn(`[a2a-cron] ${cronId} — no agent claims skill "${skill}" — dropping`);
        return;
      }

      console.log(`[a2a-cron] ${cronId} → ${agent.name}`);

      try {
        const response = await callA2A(agent, content, `workstacean-cron-${cronId}`);
        const channel = String(p.channel ?? "");
        if (channel && response) {
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

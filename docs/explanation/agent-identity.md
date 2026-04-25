---
title: Agent Identity — Multi-Bot Design and Per-Agent Tokens
---

_This is an explanation doc. It explains why the fleet uses separate identities per agent and how that affects message delivery._

---

## The fleet today

protoWorkstacean routes messages to multiple agents, each with a distinct identity and a distinct role. When an agent posts back to GitHub, Discord, or Linear, the response should appear as that agent, not as a generic "protoBot" catch-all. Attribution, filtering, and trust signals all depend on the posting identity matching the agent that produced the reply.

The current roster:

| Agent | Role | Runtime | GitHub identity | Discord identity |
|---|---|---|---|---|
| **protoMaker team** | Board ops, feature lifecycle, planning, sitreps, onboarding | External A2A (`${AVA_BASE_URL}/a2a`) | `@ava[bot]` | *shared — output via protoBot primary client* |
| **Ava** | Free-form conversational chat, delegation suggestions | In-process (`workspace/agents/ava.yaml`) | *none — Ava is DM-only today* | `@ava#3387` (dedicated pool bot) |
| **Quinn** | PR review, bug triage, security triage | External A2A (`${QUINN_BASE_URL}/a2a`) | `@protoquinn[bot]` | *shared — output via protoBot primary client* |
| **Jon / protoContent** | Content strategy, GTM, outreach | External A2A (`${PROTOCONTENT_BASE_URL}/a2a`) | n/a | `@protoJon#6536` (dedicated pool bot) |
| **Frank** | Personal chaos lab runtime | External (future) | n/a | `@frank#2599` (dedicated pool bot) |

Two important splits:

1. **"Ava" the conversational agent is not "the protoMaker team."** What used to be a single "ava" slug has been separated. The A2A runtime at `AVA_BASE_URL` is the protoMaker team — multi-agent board operations. The in-process `ava` agent is a standalone chat persona with no tools, dedicated to conversation and delegation suggestions.
2. **Discord output has two tiers.** The shared primary client (protoBot, `DISCORD_BOT_TOKEN`) handles guild messages, slash commands, HITL interactions, and team-level output from the protoMaker team and Quinn. The agent pool clients (ava, jon, frank) handle DMs directed at their specific identities and pre-warm DM channels on startup so the gateway delivers `MESSAGE_CREATE` to the right bot.

---

## GitHub App identities

Quinn and the protoMaker team each have their own GitHub App installation. Each app has an App ID and a private key (PKCS#1 PEM). The pr-remediator and A2A plugins generate short-lived installation tokens from those credentials so comments and reviews post with the right attribution.

When a PR review response lands for Quinn:
1. pr-remediator looks up the GitHub context from the inbound `correlationId` (owner, repo, number)
2. The Quinn container mints a JWT using `QUINN_APP_ID` + `QUINN_APP_PRIVATE_KEY`
3. Exchanges it for a GitHub installation token (refreshed every 45 min by an entrypoint daemon)
4. Submits the formal review via the GitHub API — shows as `@protoquinn[bot]`

When the protoMaker team creates a board feature or comments on an issue:
1. The same context lookup happens
2. The comment is posted using `AVA_APP_ID` + `AVA_APP_PRIVATE_KEY` (the env vars keep the historical name — see "Env var naming" below)
3. The comment appears as `@ava[bot]`

If GitHub App env vars are missing, calls fall back to the PAT (`GITHUB_TOKEN`), which posts as the PAT owner's account. That fallback is a debugging convenience only — production always uses App credentials.

---

## Discord: multi-bot pool architecture

Discord gives each bot a distinct identity, so the fleet runs multiple Discord clients from within the same workstacean process.

The shared primary client (`DISCORD_BOT_TOKEN` → protoBot) listens to guild messages, slash commands, HITL button interactions, and any DM that isn't directed at a specific agent-pool bot. It's the operational backbone — one client for cross-channel output.

Each agent pool client has its own token, logs in as its own identity, and pre-warms DM channels with known users at startup (Discord's gateway only pushes `MESSAGE_CREATE` events for DM channels in the session's `private_channels` list, so a fresh login needs to `createDM()` once per user to start receiving events).

The pool is defined by merging two sources:

- `workspace/agents.yaml` — A2A registry entries with `discordBotTokenEnvKey` (external agents)
- `workspace/agents/*.yaml` — in-process agent definitions with `discordBotTokenEnvKey` (runtime agents)

DM routing:

1. User DMs `@ava` in Discord
2. Ava's pool client (logged in via `DISCORD_BOT_TOKEN_AVA`) receives `MessageCreate`
3. `_handleDM(message, agentName="ava", bus)` publishes `message.inbound.discord.<channel>` with `meta.agentId=ava`
4. Router forwards to skill-dispatcher with the explicit target
5. Dispatcher resolves `ava` in the ExecutorRegistry → in-process `DeepAgentExecutor` (LangGraph)
6. Response flows back to `message.outbound.discord.<channel>` and the pool client posts as `@ava`

If a message hits the shared protoBot client (guild @-mention, DM to protoBot directly), routing falls back to `ROUTER_DM_DEFAULT_AGENT` + `ROUTER_DM_DEFAULT_SKILL` env vars — currently `ava` + `chat`, so generic DMs still land on the conversational Ava agent.

---

## Why Quinn handles Discord provisioning

The `onboard_project` skill is owned by the protoMaker team, but the `provision_discord` skill that creates Discord channels is owned by Quinn. This is a chain: protoMaker calls Quinn via `chain[onboard_project]: quinn/provision_discord`.

The reason is that Quinn has the Discord API client code and the knowledge of the standard channel structure (dev, alerts, releases). The protoMaker team handles the broader project provisioning logic (GitHub scaffold, write-back to `projects.yaml`). The chain keeps these responsibilities separate.

When the channel IDs come back from Discord, they are written to both `settings.json` in the target repo and `projects.yaml` in the protoWorkstacean repo. This makes the IDs available to both the agent running in the target repo context and the workstacean routing layer.

---

## The `contextId` in A2A calls

Agent conversation memory is scoped by `contextId` in the JSON-RPC call:

```json
{
  "params": {
    "contextId": "workstacean-{channelId}"
  }
}
```

`contextId` is derived from the message channel. For Discord, it's the Discord channel ID. For GitHub, it's `{owner}/{repo}#{number}`. For Linear, it's the `correlationId` (`linear-{issueId}`).

This means:
- All messages in the same GitHub issue share a conversation thread in the agent's memory
- All messages in the same Discord channel share a thread
- The HITL resume flow (days later) uses the same `correlationId` as the original plan request — the protoMaker team's memory of the conversation is preserved across the approval gap

---

## Env var naming — why "AVA_*" stays

The environment variables that describe the A2A connection (`AVA_BASE_URL`, `AVA_API_KEY`, `AVA_APP_ID`, `AVA_APP_PRIVATE_KEY`) keep the `AVA_*` prefix even though the runtime is the protoMaker team. These describe the HTTP service identity (historical reason: the repo has always been called the "ava" server), and renaming them would require a coordinated infisical secret migration + homelab-iac redeploy for no functional gain.

The split is conceptual:

- **`AVA_*` env vars** = the HTTP/auth identity of the protoMaker server
- **`protomaker` agent slug** = the logical routing target inside workstacean
- **`ava` (in-process)** = the conversational chat agent, a separate entity

`DISCORD_BOT_TOKEN_AVA` belongs to the in-process Ava chat agent, not the protoMaker team. `DISCORD_BOT_TOKEN_PROTO` is protoBot, the shared primary client the protoMaker team uses for its output.

---

## Secrets management

All per-agent secrets live in Infisical (AI project `11e172e0`). The workstacean container receives them via `infisical run` at deploy time. The homelab-iac `docker-compose.yml` is the canonical reference for which secrets map to which services.

No secrets are stored in this repository. `workspace/agents.yaml` uses `apiKeyEnv` to reference the env var name (e.g., `AVA_API_KEY`), not the key value itself.

---

## Adding a new agent identity

### External (A2A) agent

1. Create the agent runtime in its own repo with a JSON-RPC `/a2a` endpoint
2. (Optional) Create a GitHub App for bot attribution; generate and store the private key in Infisical
3. Add `APP_ID`, `APP_PRIVATE_KEY`, and any `API_KEY` env vars to `homelab-iac/stacks/ai/docker-compose.yml`
4. Add an entry to `workspace/agents.yaml` with `name`, `url`, `apiKeyEnv`, and declared `skills`
5. (Optional) If the agent should have its own Discord bot, add `discordBotTokenEnvKey` pointing at a new `DISCORD_BOT_TOKEN_*` env var
6. Restart workstacean — `[skill-broker] Registered N A2A agent(s)` in logs should increment

### In-process agent

1. Create `workspace/agents/{name}.yaml` with `name`, `role`, `model`, `systemPrompt`, `tools`, `skills`
2. (Optional) Add `discordBotTokenEnvKey` for a dedicated Discord identity
3. Restart workstacean — `[agent-runtime] Loaded agent "{name}"` in logs confirms the definition loaded
4. `ExecutorRegistry.resolve(skill, [name])` will route work to the in-process `DeepAgentExecutor` (LangGraph) for that agent

Both paths coexist. The ExecutorRegistry resolves by explicit target first, then by skill — so in-process and A2A agents can share a skill space without collision as long as dispatches carry `meta.agentId`.

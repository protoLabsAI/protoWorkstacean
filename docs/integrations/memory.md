---
title: User Memory (Graphiti)
---

protoWorkstacean uses [Graphiti](https://github.com/getzep/graphiti) (Zep OSS) as a temporal knowledge graph for user memory. When a user sends a message via Discord (or any platform wired to `SkillDispatcherPlugin`), relevant facts from previous conversations are automatically retrieved and prepended to the agent's context. After the agent responds, the exchange is stored as an episode for future retrieval.

## How it works

1. **Message arrives** on `agent.skill.request` (via `/publish`, Discord, etc.)
2. **Identity resolved** — `IdentityRegistry` maps the platform user ID to a canonical `user_{id}` group ID using `workspace/users.yaml`
3. **Context retrieved** — `GraphitiClient.getContextBlock()` queries Graphiti's `/get-memory` endpoint for facts relevant to the current message
4. **Two groups queried in parallel**:
   - `user_{canonicalId}` — shared across all agents (e.g. `user_josh`)
   - `agent_{agentName}__user_{canonicalId}` — per-agent (e.g. `agent_ava__user_josh`)
5. **Context prepended** to the message content as a `[User context]` block
6. **Agent executes** with enriched context
7. **Episode stored** — the original message (without context prefix) and the agent's response are stored in both groups via `/messages`

```
Discord message
    │
    ▼
SkillDispatcherPlugin
    │
    ├── IdentityRegistry.groupId("discord", userId) → "user_josh"
    │
    ├── GraphitiClient.getContextBlock("user_josh", msg)             ┐
    ├── GraphitiClient.getContextBlock("agent_ava__user_josh", msg)  ┘ parallel
    │
    ├── [User context — user_josh]                    ← prepended to content
    │   - Josh prefers concise responses
    │   - Josh is working on the protoWorkstacean project
    │
    ├── executor.execute(enrichedRequest)
    │
    └── GraphitiClient.addEpisode(...)  ← stored after response (fire-and-forget)
```

## Group ID convention

Graphiti's `validate_group_id` only accepts **alphanumeric characters, dashes, and underscores**. Colons are rejected — and the rejection crashes the ingestion worker silently (the `AsyncWorker` only catches `CancelledError`, so any other exception kills the task and every subsequent `POST /messages` piles into a dead queue with no log output).

The convention is underscore-separated:

| Source | Group ID | Example |
|--------|----------|---------|
| Known user | `user_{canonicalId}` | `user_josh` |
| Unknown user fallback | `user_{platform}_{platformId}` | `user_discord_123456789` |
| Per-agent user scope | `agent_{agent}__user_{canonicalId}` | `agent_ava__user_josh` |
| Bot-initiated (systemActor) | `system_{actor}` | `system_pr-remediator` |

Double underscore (`__`) separates identity segments in the per-agent group — a single underscore would collide with the unknown-user fallback. Dashes are fine inside actor/user names.

## Configuration

Set `GRAPHITI_URL` to point at the Graphiti sidecar:

```dotenv
GRAPHITI_URL=http://graphiti:8000
```

Graphiti itself requires:

```dotenv
OPENAI_API_KEY=...          # or LiteLLM master key
OPENAI_BASE_URL=...         # point at LiteLLM gateway for cost control
MODEL_NAME=claude-haiku-4-5 # model for fact extraction
EMBEDDING_MODEL_NAME=...    # embedding model
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=...
```

**Required gateway aliases.** Graphiti internally references two OpenAI model names that must exist in the LiteLLM gateway config:

- `text-embedding-3-small` — Graphiti's default embedder; route to your actual embedding model
- `gpt-4.1-nano` — Graphiti's `DEFAULT_SMALL_MODEL` used for attribute extraction; route to a fast/cheap model (e.g. `claude-haiku-4-5`)

Without these aliases, episode ingestion fails with `400 Invalid model name` during entity extraction, and the `AsyncWorker` dies silently.

**Neo4j 5.18+ required** — Graphiti uses `vector.similarity.cosine()`, which was added in Neo4j 5.18. Earlier versions will throw "Unknown function" at query time.

If `GRAPHITI_URL` is not set, the client defaults to `http://graphiti:8000`. If Graphiti is unreachable, memory enrichment is skipped silently — the message is still processed.

## User identity (`workspace/users.yaml`)

The `IdentityRegistry` maps platform-specific IDs to a canonical user, enabling cross-platform memory continuity:

```yaml
users:
  - id: josh              # canonical ID — becomes "user_josh" in Graphiti
    displayName: Josh
    admin: true
    memoryEnabled: true   # default: true
    identities:
      discord: "123456789012345678"   # Discord snowflake
      github: "bioshazard"
      linear: "98de077d-fcdc-4708-93dc-3f2cde045f38"  # Linear user UUID (not email)
      signal: "+15555555555"          # E.164
```

**Group ID resolution**:
- Mapped user: `user_{id}` → e.g. `user_josh`
- Unknown user: `user_{platform}_{platformId}` → e.g. `user_discord_123456789012345678`

Memory is scoped to these group IDs — facts never bleed across users.

**Getting your Discord snowflake**: Discord Settings → Advanced → enable Developer Mode → right-click your avatar → Copy User ID.

## Per-agent memory groups

Each agent builds its own relationship with the user on top of the shared baseline:

| Group ID | Purpose |
|----------|---------|
| `user_josh` | Shared — facts common to all interactions |
| `agent_ava__user_josh` | Ava-specific — how Josh interacts with Ava specifically |
| `agent_quinn__user_josh` | Quinn-specific — Quinn's knowledge of Josh's review preferences |

Both groups are queried and written on every skill dispatch. The combined context is deduplicated by Graphiti's fact extraction, so duplicate facts don't accumulate.

## Bot-initiated memory (`systemActor`)

Bot-initiated dispatches — PR remediator, triage sweep, cron ceremonies — don't have a human user ID, but they should still accumulate their own episodic memory so the autonomous loop learns over time. When the publisher sets `meta.systemActor` on the skill request, the dispatcher writes episodes to a stable `system_{actor}` group:

```typescript
bus.publish("agent.skill.request", {
  payload: {
    skill: "pr_review",
    content: "...",
    meta: {
      agentId: "ava",
      skillHint: "pr_review",
      systemActor: "pr-remediator",  // → episodes land in system_pr-remediator
    },
  },
});
```

No user split here — `systemActor` IS the actor. The autonomous loop builds its own history grouped by the subsystem that triggered it (pr-remediator, auto-triage-sweep, ceremony.security-triage, etc.).

## Discord `/memory` command

Users can inspect and manage their memory via the Discord slash command:

| Subcommand | Description |
|-----------|-------------|
| `/memory show` | List active (non-expired) facts about you |
| `/memory search <query>` | Search memory for a specific topic |
| `/memory clear` | Delete all memory (admin only) |

The command response is ephemeral (only visible to you).

## Fact lifecycle

Graphiti extracts facts from each episode automatically using its configured LLM. Facts have temporal metadata:

- `valid_at` — when the fact became true
- `invalid_at` — when it was superseded (e.g. "lives in Berlin" invalidated when "moved to London")
- `expired_at` — TTL-based expiry

Expired or invalidated facts are filtered out by `getContextBlock()` before being shown to agents or users.

## Disabling memory per user

Set `memoryEnabled: false` in `workspace/users.yaml` to opt a user out:

```yaml
- id: bot-account
  memoryEnabled: false
  identities:
    discord: "9999999999"
```

Cron/system events (no `userId` in the message source) are always skipped — memory only applies to human-initiated interactions.

## Health monitoring

The `memory` world-state domain polls `/api/memory-health`, which issues two probes:

- `GET /healthcheck` against Graphiti (catches: service down)
- `POST /search` with a trivial query (catches: Neo4j vector functions missing, embedder misconfigured, gateway model aliases missing)

Two goals in `workspace/goals.yaml` alert on either probe failing:

- `memory.graphiti_healthy` (critical) — `domains.memory.data.healthy` must be 1
- `memory.search_working` (high) — `domains.memory.data.searchOk` must be 1

Search probing catches the silent failure modes that healthcheck alone misses: a healthy-looking Graphiti container whose ingestion worker has died because of a malformed group_id or a missing model alias will still return `/healthcheck 200`, but `/search` will surface the deeper wiring issue.

## Privacy and GDPR

All memory for a user can be deleted with `/memory clear` (Discord) or programmatically:

```typescript
await graphiti.clearUser("user_josh");  // cascades to all episodes, entities, edges
```

This is a hard delete from Neo4j — irreversible.

## Docker Compose setup

See `homelab-iac/stacks/ai/docker-compose.yml` for the reference deployment. Key points:

- Graphiti runs as a sidecar (`zepai/graphiti:latest`)
- Connects to the shared `neo4j` instance in `homelab-iac/stacks/infra` over `infra_default`
- `NEO4J_PASSWORD` and `LITELLM_MASTER_KEY` are injected via Infisical
- workstacean's `GRAPHITI_URL` points at `http://graphiti:8000`

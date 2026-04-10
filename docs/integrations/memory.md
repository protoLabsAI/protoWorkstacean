---
title: User Memory (Graphiti)
---

protoWorkstacean uses [Graphiti](https://github.com/getzep/graphiti) (Zep OSS) as a temporal knowledge graph for user memory. When a user sends a message via Discord (or any platform wired to `SkillDispatcherPlugin`), relevant facts from previous conversations are automatically retrieved and prepended to the agent's context. After the agent responds, the exchange is stored as an episode for future retrieval.

## How it works

1. **Message arrives** on `agent.skill.request` (via `/publish`, Discord, etc.)
2. **Identity resolved** — `IdentityRegistry` maps the platform user ID to a canonical `user:{id}` group ID using `workspace/users.yaml`
3. **Context retrieved** — `GraphitiClient.getContextBlock()` queries Graphiti's `/get-memory` endpoint for facts relevant to the current message
4. **Two groups queried in parallel**:
   - `user:{canonicalId}` — shared across all agents (e.g. `user:josh`)
   - `agent:{agentName}:user:{canonicalId}` — per-agent (e.g. `agent:ava:user:josh`)
5. **Context prepended** to the message content as a `[User context]` block
6. **Agent executes** with enriched context
7. **Episode stored** — the original message (without context prefix) and the agent's response are stored in both groups via `/messages`

```
Discord message
    │
    ▼
SkillDispatcherPlugin
    │
    ├── IdentityRegistry.groupId("discord", userId) → "user:josh"
    │
    ├── GraphitiClient.getContextBlock("user:josh", msg)       ┐
    ├── GraphitiClient.getContextBlock("agent:ava:user:josh", msg)  ┘ parallel
    │
    ├── [User context — user:josh]                    ← prepended to content
    │   - Josh prefers concise responses
    │   - Josh is working on the protoWorkstacean project
    │
    ├── executor.execute(enrichedRequest)
    │
    └── GraphitiClient.addEpisode(...)  ← stored after response (fire-and-forget)
```

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

If `GRAPHITI_URL` is not set, the client defaults to `http://graphiti:8000`. If Graphiti is unreachable, memory enrichment is skipped silently — the message is still processed.

## User identity (`workspace/users.yaml`)

The `IdentityRegistry` maps platform-specific IDs to a canonical user, enabling cross-platform memory continuity:

```yaml
users:
  - id: josh              # canonical ID — becomes "user:josh" in Graphiti
    displayName: Josh
    admin: true
    memoryEnabled: true   # default: true
    identities:
      discord: "123456789012345678"   # Discord snowflake
      github: "bioshazard"
      signal: "+15555555555"          # E.164
```

**Group ID resolution**:
- Mapped user: `user:{id}` → e.g. `user:josh`
- Unknown user: `user:{platform}_{platformId}` → e.g. `user:discord_123456789012345678`

Memory is scoped to these group IDs — facts never bleed across users.

**Getting your Discord snowflake**: Discord Settings → Advanced → enable Developer Mode → right-click your avatar → Copy User ID.

## Per-agent memory groups

Each agent builds its own relationship with the user on top of the shared baseline:

| Group ID | Purpose |
|----------|---------|
| `user:josh` | Shared — facts common to all interactions |
| `agent:ava:user:josh` | Ava-specific — how Josh interacts with Ava specifically |
| `agent:quinn:user:josh` | Quinn-specific — Quinn's knowledge of Josh's review preferences |

Both groups are queried and written on every skill dispatch. The combined context is deduplicated by Graphiti's fact extraction, so duplicate facts don't accumulate.

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

## Privacy and GDPR

All memory for a user can be deleted with `/memory clear` (Discord) or programmatically:

```typescript
await graphiti.clearUser("user:josh");  // cascades to all episodes, entities, edges
```

This is a hard delete from Neo4j — irreversible.

## Docker Compose setup

See `homelab-iac/stacks/ai/docker-compose.yml` for the reference deployment. Key points:

- Graphiti runs as a sidecar (`zepai/graphiti:latest`)
- Shares the `research-neo4j` Neo4j instance with other tools
- `NEO4J_PASSWORD` and `LITELLM_MASTER_KEY` are injected via Infisical
- workstacean's `GRAPHITI_URL` points at `http://graphiti:8000`

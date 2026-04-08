# Agent Skills Reference

_This is a reference doc. It lists all skills in the agent registry, their routing keywords, and the agents that handle them._

---

Skills are declared in `workspace/agents.yaml`. On startup, the A2APlugin fetches each agent's `/.well-known/agent.json` and overwrites with live skills if available. The table below reflects the static registry.

---

## Skill routing

Skills are matched in priority order:

1. **Explicit hint** — `payload.skillHint` bypasses keyword matching (set by GitHubPlugin, DiscordPlugin, PlanePlugin)
2. **Keyword match** — content scanned against the keyword table below
3. **Default** — falls back to Ava

---

## Skill registry

### Quinn (`http://quinn:7870/a2a`)

| Skill | Keywords | Description |
|-------|----------|-------------|
| `bug_triage` | bug, issue, broken, crash, error, fail, exception, triage, TypeError, ReferenceError | Classify and triage a bug report; optionally file a board item via `file_bug` tool |
| `qa_report` | report, qa, digest, quality, /report | Generate a QA status digest for a project or sprint |
| `board_audit` | audit, board, backlog, sprint, features, /audit | Audit the project board for staleness and hygiene |
| `pr_review` | pr, pull request, review, merge, ci, /review | Full PR review with vector context (past decisions + similar patterns) |
| `provision_discord` | (chain only) | Create Discord category + channels for a new project; called by chain from `onboard_project` |

**Chain:** `bug_triage → ava/manage_feature`

After Quinn completes `bug_triage`, A2APlugin automatically calls Ava's `manage_feature` with Quinn's response + original context. One level deep only.

---

### Ava (`http://automaker-server:3008/a2a`)

| Skill | Keywords | Description |
|-------|----------|-------------|
| `sitrep` | status, sitrep, situation, summary, /sitrep | Current sprint/project status summary |
| `manage_feature` | create feature, new feature, unblock, assign, move to, add to board | Create or update a feature on the board |
| `board_health` | blocked, stalled, stuck, health, unhealthy | Surface blocked or stalled features |
| `auto_mode` | auto mode, start auto, stop auto, pause auto | Toggle autonomous background work mode |
| `onboard_project` | onboard, new project, add project, /onboard | Full project onboarding chain (GitHub + Plane + Discord) |
| `plan` | idea, plan, build, proposal, project idea, /plan | Generate SPARC PRD + antagonistic review + HITL gate |
| `plan_resume` | (not keyword-matched) | Resume a plan after HITLResponse arrives on bus with matching `correlationId` |

---

### Frank (`http://frank:7880/a2a`)

| Skill | Keywords | Description |
|-------|----------|-------------|
| `infra_health` | infra, deploy, monitoring, node, container | Infrastructure health check |
| `deploy` | deploy | Deploy a service or artifact |
| `monitoring` | monitoring | Check monitoring dashboards and alerts |

---

### Jon (GTM)

| Skill | Keywords | Description |
|-------|----------|-------------|
| `market_review` | market, competition | Market landscape review |
| `positioning` | positioning | Product positioning analysis |
| `antagonistic_review` | (chain only) | Strategic lens review; called by Ava during `plan` skill |

---

### Cindi (GTM)

| Skill | Keywords | Description |
|-------|----------|-------------|
| `blog` | blog, post | Write or review blog content |
| `seo` | seo, search | SEO analysis |
| `content_review` | content review | Review content for quality and messaging |

---

### Researcher (Knowledge)

| Skill | Keywords | Description |
|-------|----------|-------------|
| `research` | research, investigate, deep dive, knowledge | Deep research with entity extraction |
| `entity_extract` | entity, extract | Extract structured entities from text |

---

## Adding a new agent

1. Add the agent to `workspace/agents.yaml`:

```yaml
agents:
  - name: my-agent
    team: dev
    url: http://my-agent:PORT/a2a
    apiKeyEnv: MY_AGENT_API_KEY
    skills:
      - my_skill
```

2. Add keyword entries to `SKILL_KEYWORDS` in `src/plugins/a2a.ts` for keyword routing.
3. Optionally add `chain` entries for follow-up chains.
4. Restart: `docker restart workstacean`

The A2APlugin fetches `/.well-known/agent.json` from the agent URL on startup and merges live skills — so the `agents.yaml` entry only needs to be approximate.

---

## A2A protocol

All agent calls use JSON-RPC 2.0 `message/send`:

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "message/send",
  "params": {
    "message": { "role": "user", "parts": [{ "kind": "text", "text": "..." }] },
    "contextId": "workstacean-{channel}"
  }
}
```

Timeout: 120s per agent call. `contextId` is derived from the message channel so conversation threads persist.

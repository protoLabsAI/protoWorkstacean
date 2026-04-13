---
title: HTTP API Reference
---

All HTTP endpoints exposed by protoWorkstacean. The server listens on `WORKSTACEAN_HTTP_PORT` (default `3000`).

Route modules live in `src/api/` — `operations.ts`, `world-state.ts`, `github.ts`, `incidents.ts` — each returning an array of routes mounted by `src/api/index.ts`.

## Response envelope

Most endpoints wrap their payload in a `{ success, data }` envelope:

```json
{ "success": true, "data": ... }
```

Error responses use the same envelope:

```json
{ "success": false, "error": "Reason string" }
```

A few endpoints return raw objects without the envelope (`/api/services`, `/api/agent-health`, `/api/ci-health`, `/api/pr-pipeline`, `/api/branch-drift`, `/api/security-summary`, `/api/outcomes`, `/api/world-state/:domain`). The dashboard's API client detects the envelope and unwraps it automatically.

## Authentication

Read endpoints are unauthenticated. Mutating endpoints (`/publish`, `/api/onboard`, `/api/ceremonies/:id/run`, `/api/incidents`, `/api/incidents/:id/resolve`) require `X-API-Key: $WORKSTACEAN_API_KEY`. If `WORKSTACEAN_API_KEY` is unset, authentication is skipped entirely.

---

## GET /health

Server liveness probe.

**Auth**: None

**Response** (`200`):
```json
{ "status": "ok", "timestamp": 1712563200000 }
```

---

## POST /publish

Inject a message onto the event bus. Primary integration point for external callers.

**Auth**: API key

**Request body**:
```typescript
{
  topic: string;           // Bus topic (e.g. "agent.skill.request")
  payload: unknown;        // Arbitrary payload — shape depends on topic
  correlationId?: string;  // Trace ID. Auto-generated if omitted.
}
```

**Example — dispatch a skill**:
```bash
curl -X POST http://localhost:3000/publish \
  -H "X-API-Key: $WORKSTACEAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "agent.skill.request",
    "payload": {
      "skill": "sitrep",
      "content": "What is the current status?",
      "replyTopic": "agent.skill.response.my-trace-001"
    }
  }'
```

**Response** (`200`): `{ "success": true }`

---

## POST /api/onboard

Publish an onboarding request for a new project. The OnboardingPlugin subscribes to `message.inbound.onboard` and runs the pipeline asynchronously.

**Auth**: API key

**Request body**: Free-form JSON; published as the message payload. Typical fields:
```typescript
{
  owner?: string;
  repo?: string;
  description?: string;
}
```

**Response** (`200`):
```json
{ "success": true, "message": "Onboarding request published" }
```

---

## GET /api/projects

List registered projects from `workspace/projects.yaml`.

**Auth**: None

**Response** (`200`):
```json
{
  "success": true,
  "data": [
    {
      "slug": "my-project",
      "owner": "my-org",
      "repo": "my-repo",
      "github": "my-org/my-repo",
      "discordChannels": ["1234567890"]
    }
  ]
}
```

Returns `{ "success": true, "data": [] }` if `projects.yaml` is missing.

---

## GET /api/agents

List agents loaded from `workspace/agents.yaml`.

**Auth**: None

**Response** (`200`):
```json
{
  "success": true,
  "data": [
    {
      "name": "ava",
      "executor": "proto-sdk",
      "skills": ["chat"]
    },
    {
      "name": "protomaker",
      "executor": "a2a",
      "skills": ["sitrep", "plan", "board_health", "manage_feature", "bug_triage"]
    },
    {
      "name": "quinn",
      "executor": "a2a",
      "skills": ["pr_review", "bug_triage", "security_triage"]
    }
  ]
}
```

---

## GET /api/goals

Return the raw contents of `workspace/goals.yaml` (the `goals` key). This is the loaded goal definitions, **not** their current evaluation status.

**Auth**: None

**Response** (`200`):
```json
{
  "success": true,
  "data": [
    {
      "id": "ci.success_rate_healthy",
      "type": "threshold",
      "severity": "high",
      "domain": "ci",
      "path": "successRate",
      "min": 0.8
    }
  ]
}
```

For live goal evaluation, the dashboard's Goals page runs `src/lib/goal-evaluator.ts` client-side against `/api/world-state`.

---

## GET /api/ceremonies

List all ceremony definitions parsed from `workspace/ceremonies/*.yaml`.

**Auth**: None

**Response** (`200`):
```json
{
  "success": true,
  "data": [
    {
      "id": "daily-standup",
      "name": "Daily Fleet Standup",
      "schedule": "0 9 * * 1-5",
      "skill": "board_audit",
      "enabled": true
    }
  ]
}
```

---

## POST /api/ceremonies/:id/run

Manually trigger a ceremony outside its cron schedule. Publishes `ceremony.<id>.execute` with `{ type: "manual.execute", triggeredBy: "api" }`.

**Auth**: API key

**Path params**:
- `id` — ceremony ID (validated against `^[\w.\-]+$`)

**Response** (`200`):
```json
{ "success": true, "message": "Ceremony \"daily-standup\" triggered" }
```

---

## GET /api/skills/:agentName

Return the skills registered for a specific agent.

**Auth**: None

**Path params**:
- `agentName` — agent name (e.g. `protomaker`, `quinn`, `ava`)

**Response** (`200`):
```json
{
  "success": true,
  "data": {
    "name": "protomaker",
    "skills": [
      { "name": "sitrep", "description": "Generate a situational awareness report" }
    ]
  }
}
```

Returns `404` if the agent is not registered in `agents.yaml`.

---

## GET /api/channels

Returns an empty list. Channels are loaded at startup by `ChannelRegistry` from `workspace/channels.yaml` and consumed internally; they are not currently exposed via HTTP.

**Auth**: None

**Response** (`200`):
```json
{ "success": true, "data": [] }
```

---

## GET /api/hitl/pending

List pending Human-in-the-Loop approval requests.

**Auth**: None

**Response** (`200`):
```json
{
  "success": true,
  "data": [
    {
      "id": "hitl-abc123",
      "type": "prd_approval",
      "projectSlug": "my-project",
      "summary": "Approve PRD for feature X",
      "createdAt": "2026-04-09T09:00:00.000Z",
      "expiresAt": "2026-04-10T09:00:00.000Z"
    }
  ]
}
```

Returns `{ "success": true, "data": [] }` if the HITL plugin is not registered.

---

## GET /api/world-state

Return the current snapshot of all registered world-state domains. The engine caches collected values; stale data older than `120_000 ms` is evicted.

**Auth**: None

**Response** (`200`):
```json
{
  "success": true,
  "data": {
    "domains": {
      "board": {
        "name": "board",
        "data": { "efficiency": 0.47, "totalItems": 23 },
        "collectedAt": 1712563200000,
        "metadata": { "failed": false, "httpStatus": 200 }
      },
      "ci": {
        "name": "ci",
        "data": { "successRate": 0.85 },
        "collectedAt": 1712563200000,
        "metadata": { "failed": false, "httpStatus": 200 }
      }
    }
  }
}
```

Returns `503` if the `world-state-engine` plugin is unavailable.

---

## GET /api/world-state/:domain

Return the current snapshot for a single domain. Bypasses the envelope — returns the raw domain record.

**Auth**: None

**Path params**:
- `domain` — domain name as registered

**Response** (`200`): same shape as one entry of `data.domains` above.

Returns `503` if the engine is unavailable.

---

## GET /api/services

Service connectivity summary for the Overview dashboard. Checks env-var presence and (for Discord) the live client's `isReady()` state. **No envelope** — returns a raw object.

**Auth**: None

**Response** (`200`):
```json
{
  "discord":  { "configured": true, "connected": true, "bot": "Quinn#1234" },
  "github":   { "configured": true, "authType": "app" },
  "plane":    { "configured": true, "baseUrl": "https://plane.example.com" },
  "gateway":  { "configured": true, "url": "http://gateway:4000/v1" },
  "langfuse": { "configured": true },
  "graphiti": { "configured": false, "url": null }
}
```

`github.authType` is `"app"` when a Quinn GitHub App key is set, `"token"` when `GITHUB_TOKEN` is set, otherwise `null`.

---

## GET /api/agent-health

Agent executor registry summary. **No envelope.**

**Auth**: None

**Response** (`200`):
```json
{
  "agentCount": 3,
  "agents": {
    "ava":        { "skills": ["chat"],                               "executorType": "proto-sdk" },
    "protomaker": { "skills": ["sitrep", "plan", "manage_feature"],   "executorType": "a2a" },
    "quinn":      { "skills": ["pr_review", "bug_triage"],            "executorType": "a2a" }
  },
  "registrationCount": 6
}
```

---

## GET /api/flow-metrics

Return all flow efficiency metrics from the FlowMonitor plugin.

**Auth**: None

**Response** (`200`):
```json
{
  "success": true,
  "data": {
    "cycleTimeP50Ms": 86400000,
    "cycleTimeP90Ms": 259200000,
    "throughputPerWeek": 4.2,
    "wipCount": 3,
    "efficiency": { "ratio": 0.47, "healthy": false }
  },
  "collectedAt": 1712563200000
}
```

Returns `503` if the `flow-monitor` plugin is not registered.

---

## GET /api/flow-metrics/:metric

Return a single flow metric by name.

**Auth**: None

**Path params**:
- `metric` — metric name (e.g. `cycleTimeP50Ms`, `wipCount`, `efficiency`)

**Response**: same envelope shape as `/api/flow-metrics`, with `data` containing only the requested metric.

Returns `503` if the plugin is not registered.

---

## GET /api/outcomes

GOAP action dispatch outcomes tracked by the ActionDispatcher. Feeds the dashboard's Goals & Outcomes page and the plan-learning flywheel. **No envelope.**

**Auth**: None

**Response** (`200`):
```json
{
  "summary": { "success": 428, "failure": 61, "timeout": 12, "total": 501 },
  "recent": [
    {
      "correlationId": "corr-abc",
      "actionId": "ci.retry_failed_workflows",
      "goalId": "ci.success_rate_healthy",
      "status": "success",
      "startedAt": 1712563200000,
      "durationMs": 4321
    }
  ]
}
```

`recent` contains the last 50 outcomes in chronological order. Returns `{ summary: { success: 0, failure: 0, timeout: 0, total: 0 }, recent: [] }` if the ActionDispatcher is not registered.

---

## GET /api/memory-health

Two-stage probe of the Graphiti episodic memory backend. Backs the `memory` world-state domain and the `memory.graphiti_healthy` / `memory.search_working` goals. **No envelope.**

**Auth**: None

**Response** (`200`):
```json
{
  "healthy": 1,
  "searchOk": 1,
  "error": ""
}
```

- `healthy` — `1` if `GET {GRAPHITI_URL}/healthcheck` returned `200`, else `0`
- `searchOk` — `1` if a trivial `POST /search` succeeded, else `0`. Search probing catches the deeper wiring failures (Neo4j vector functions missing, embedder misconfigured, gateway model aliases missing) that `/healthcheck` alone can't see
- `error` — empty string on success, otherwise a short failure reason (e.g. `"search 400"` or a connection error message)

Both probes have short timeouts (3s for healthcheck, 5s for search) so the world-state tick isn't blocked by a hung Graphiti container.

---

## GET /api/ci-health

Poll GitHub Actions success rate for every project in `projects.yaml`. Makes one GitHub REST call per project — **subject to rate limits**; cache aggressively on the client side (dashboard TTL: 5 min). **No envelope.**

**Auth**: None (but requires `GITHUB_TOKEN` server-side)

**Response** (`200`):
```json
{
  "successRate": 0.87,
  "totalRuns": 150,
  "failedRuns": 20,
  "projects": [
    {
      "repo": "my-org/my-repo",
      "successRate": 0.9,
      "totalRuns": 10,
      "failedRuns": 1,
      "latestConclusion": "success"
    }
  ]
}
```

Each repo entry falls back to `{ successRate: 0, totalRuns: 0, ... }` if the GitHub call fails. Returns defaults if no projects are registered.

---

## GET /api/pr-pipeline

Aggregate open-PR state across every project. Each PR is fetched individually for reliable `mergeable_state`, with real CI status from the Check Runs API and review decision from the reviews API. **No envelope.**

**Auth**: None (requires `GITHUB_TOKEN`)

**Response** (`200`):
```json
{
  "totalOpen": 12,
  "conflicting": 1,
  "stale": 3,
  "failingCi": 2,
  "changesRequested": 1,
  "readyToMerge": 4,
  "prs": [
    {
      "repo": "my-org/my-repo",
      "number": 42,
      "title": "feat: widget",
      "headSha": "abc123...",
      "mergeable": "clean",
      "ciStatus": "pass",
      "reviewState": "approved",
      "isDraft": false,
      "readyToMerge": true,
      "updatedAt": "2026-04-08T12:00:00Z",
      "stale": false,
      "labels": ["ready-to-merge"]
    }
  ]
}
```

Per-PR fields:
- `mergeable` — `"clean" | "dirty" | "blocked" | "unknown"` (from individual PR endpoint — the list endpoint returns null)
- `ciStatus` — `"pass" | "fail" | "pending" | "none"` (aggregated Check Runs on the head commit)
- `reviewState` — `"approved" | "changes_requested" | "pending" | "none"` (latest review per reviewer)
- `isDraft` — draft PRs are never `readyToMerge`
- `readyToMerge` — `true` only if `!isDraft && mergeable === "clean" && ciStatus === "pass" && reviewState !== "changes_requested"`

Aggregate counts:
- `conflicting` — `mergeable === "dirty"`
- `stale` — last update older than 7 days
- `failingCi` — real CI failure (`ciStatus === "fail"`)
- `changesRequested` — at least one reviewer blocking with `CHANGES_REQUESTED`
- `readyToMerge` — green + mergeable + not blocked

This is the source of truth consumed by the `pr_pipeline` world-state domain and the `PrRemediatorPlugin`. A cache or TTL of 2–5 min is recommended since each tick does `1 + 3N` GitHub API calls per repo.

---

## GET /api/branch-drift

Compare `dev → staging → main` ahead-counts per project. Surfaces unreleased work sitting in `dev`. **No envelope.**

**Auth**: None (requires `GITHUB_TOKEN`)

**Response** (`200`):
```json
{
  "projects": [
    {
      "repo": "my-org/my-repo",
      "defaultBranch": "main",
      "devToMain": 12,
      "devToStaging": 5,
      "stagingToMain": 7
    }
  ],
  "maxDrift": 12
}
```

`devToStaging` and `stagingToMain` are `null` if the `staging` branch does not exist. Returns `{ projects: [], maxDrift: 0 }` if no projects are registered or `GITHUB_TOKEN` is unset.

---

## GET /api/incidents

List all incidents from `workspace/incidents.yaml`.

**Auth**: None

**Response** (`200`):
```json
{
  "success": true,
  "data": [
    {
      "id": "INC-001",
      "title": "Dependency vulnerability detected",
      "severity": "high",
      "status": "open",
      "reportedAt": "2026-04-08T08:00:00.000Z"
    }
  ]
}
```

---

## GET /api/security-summary

Aggregated security incident counts for the Overview dashboard. **No envelope.**

**Auth**: None

**Response** (`200`):
```json
{
  "openCount": 2,
  "criticalCount": 1,
  "incidents": [
    { "id": "INC-001", "title": "...", "severity": "high", "status": "open" }
  ]
}
```

Only non-resolved incidents are included.

---

## POST /api/incidents

Report a new incident. Appends to `incidents.yaml` and publishes `security.incident.reported`.

**Auth**: API key

**Request body**:
```typescript
{
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  description?: string;
  affectedProjects?: string[];
  assignee?: string;
  status?: "open" | "investigating" | "resolved";  // defaults to "open"
}
```

**Response** (`201`):
```json
{
  "success": true,
  "data": {
    "id": "INC-042",
    "title": "...",
    "severity": "high",
    "status": "open",
    "reportedAt": "2026-04-09T09:00:00.000Z"
  }
}
```

IDs are auto-generated as `INC-NNN` (zero-padded to 3 digits, monotonically increasing).

---

## POST /api/incidents/:id/resolve

Mark an incident as resolved. Rewrites `incidents.yaml` and republishes `security.incident.reported`.

**Auth**: API key

**Path params**:
- `id` — incident ID (e.g. `INC-042`)

**Response** (`200`):
```json
{
  "success": true,
  "data": { "id": "INC-042", "status": "resolved", "..." : "..." }
}
```

Returns `404` if the ID is not found or `incidents.yaml` is missing.

---

## POST /api/a2a/chat

Synchronous multi-turn conversation with a remote A2A agent. Calls the agent's executor directly (bypasses the bus) and returns the response. Used by Ava's `chat_with_agent` tool.

**Auth**: API key

**Request body**:
```typescript
{
  agent: string;       // Agent name: "quinn", "protomaker", "protocontent", "frank"
  message: string;     // What to say
  contextId?: string;  // From prior turn — omit for new conversation
  taskId?: string;     // From prior turn — continues a specific task
  skill?: string;      // Skill hint (default: "chat")
  done?: boolean;      // Set true on final message to end conversation
}
```

**Response** (`200`):
```json
{
  "success": true,
  "data": {
    "response": "Quinn's reply text...",
    "contextId": "conv-uuid",
    "taskId": "task-uuid",
    "taskState": "completed",
    "correlationId": "trace-uuid",
    "agent": "quinn"
  }
}
```

When `done: true`, `contextId` and `taskId` are omitted from the response. `taskState` reflects the A2A task lifecycle: `working`, `input-required`, `completed`, `failed`, `canceled`, `rejected`.

Publishes `agent.chat.outbound` (Ava's message) and `agent.chat.inbound` (agent's response) events to the bus for Discord o11y.

---

## POST /api/a2a/delegate

Fire-and-forget task dispatch to a remote agent. Publishes to `agent.skill.request` on the bus and returns immediately without waiting for the agent's response.

**Auth**: API key

**Request body**:
```typescript
{
  agent: string;        // Agent name
  skill: string;        // Skill to invoke
  message: string;      // Task description
  projectSlug?: string; // Project scope for routing
}
```

**Response** (`200`):
```json
{
  "success": true,
  "data": {
    "correlationId": "trace-uuid",
    "message": "Task delegated to quinn (skill: pr_review)"
  }
}
```

---

## POST /api/github/issues

File an issue on a managed GitHub repository. Only repos listed in `projects.yaml` are allowed.

**Auth**: API key

**Request body**:
```typescript
{
  repo: string;        // "owner/name" format, e.g. "protoLabsAI/protoWorkstacean"
  title: string;       // Issue title
  body?: string;       // Issue body (markdown)
  labels?: string[];   // Labels to apply
}
```

**Response** (`200`):
```json
{
  "success": true,
  "data": { "number": 42, "html_url": "https://github.com/...", "title": "..." }
}
```

Returns `403` if the repo is not in `projects.yaml`.

---

## POST /api/ceremonies/create

Create a new scheduled ceremony. Writes YAML to `workspace/ceremonies/` and registers with the hot-reload watcher.

**Auth**: API key

**Request body**:
```typescript
{
  id: string;            // Unique ID (alphanumeric, dots, dashes)
  name: string;          // Human-readable name
  schedule: string;      // Cron expression, e.g. "*/30 * * * *"
  skill: string;         // Skill to invoke when ceremony fires
  targets?: string[];    // Agent targets (default: ["all"])
  enabled?: boolean;     // Default: true
  notifyChannel?: string; // Discord channel ID for notifications
}
```

**Response** (`200`):
```json
{ "success": true, "data": { "id": "my.ceremony", "name": "...", "schedule": "...", "..." } }
```

---

## POST /api/ceremonies/:id/update

Update an existing ceremony. Merges fields into the existing YAML.

**Auth**: API key

**Path params**: `id` — ceremony ID

**Request body**: Same fields as create (all optional except `id`).

---

## POST /api/ceremonies/:id/delete

Delete a ceremony. Removes the YAML file and unregisters from the scheduler.

**Auth**: API key

**Path params**: `id` — ceremony ID

---

## POST /api/board/features/create

Create a feature on the protoMaker board. Proxies to the Studio MCP server at `AVA_BASE_URL`.

**Auth**: API key

**Request body**:
```typescript
{
  projectPath: string;      // Absolute path to project directory
  title: string;            // Feature title
  description?: string;     // Feature description
  status?: string;          // Default: "backlog"
  priority?: number;        // 0=none, 1=urgent, 2=high, 3=normal, 4=low
  complexity?: string;      // "small" | "medium" | "large" | "architectural"
  projectSlug?: string;
}
```

---

## POST /api/board/features/update

Update an existing feature on the protoMaker board.

**Auth**: API key

**Request body**:
```typescript
{
  projectPath: string;
  featureId: string;        // Feature UUID
  title?: string;
  description?: string;
  status?: string;          // "backlog" | "in-progress" | "review" | "done"
  priority?: number;
  complexity?: string;
}
```

---

## Dashboard proxy

The event-viewer plugin (port `8080`, disabled by `DISABLE_EVENT_VIEWER`) serves the Astro dashboard from `dashboard/dist/` and proxies unmatched `/api/*` requests plus the `/ws` WebSocket to the main HTTP server on `WORKSTACEAN_HTTP_PORT`. The dashboard's client-side API client talks only to the event-viewer port, so CORS is never an issue. See [Dashboard](./dashboard) for details.

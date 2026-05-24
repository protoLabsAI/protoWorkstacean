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

A few endpoints return raw objects without the envelope (`/api/ci-health`, `/api/pr-pipeline`, `/api/branch-drift`, `/api/security-summary`). The dashboard's API client detects the envelope and unwraps it automatically.

## Authentication

Read endpoints are unauthenticated. Mutating endpoints (`/publish`, `/api/onboard`, `/api/ceremonies/:id/run`, `/api/incidents`, `/api/incidents/:id/resolve`) require `X-API-Key: $WORKSTACEAN_API_KEY`. If `WORKSTACEAN_API_KEY` is unset, authentication is skipped entirely.

### Per-agent API keys (multi-tenant model)

The ceremony endpoints (`GET /api/ceremonies`, `POST /api/ceremonies/create`, `POST /api/ceremonies/:id/update`, `POST /api/ceremonies/:id/delete`) additionally support per-agent identity resolution.

- The legacy `WORKSTACEAN_API_KEY` is the **admin key** — sees all ceremonies, can create/update/delete any of them, can override `createdBy` on create.
- Per-agent keys are declared in `workspace/agent-keys.yaml`:
  ```yaml
  keys:
    quinn:
      envKey: WORKSTACEAN_API_KEY_QUINN
    jon:
      envKey: WORKSTACEAN_API_KEY_JON
  ```
  Set the env var (via Infisical), the registry hot-reloads. When an agent calls with its own key, every ceremony it creates is stamped `createdBy: <agentName>` automatically. Update / delete are gated by `caller.agentName === ceremony.createdBy`. List filters to caller's own ceremonies (`?all=true` for admin-only fleet view).
- Agents cannot override `createdBy` on create or transfer ownership on update — those are admin-only.
- Backward-compatible: workspaces without `agent-keys.yaml` keep single-key admin behavior. Agents using the admin key bypass ownership checks.

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

## GET /api/bus/topology

Return the plugin → topics graph: which plugins publish/subscribe to which topics. Built from each plugin's declarative `publishes` and `subscribes` arrays. Useful for spotting orphan topics (declared subscriber with no publisher, or vice versa).

**Auth**: None

**Response** (`200`):
```json
{
  "success": true,
  "data": {
    "plugins": [
      {
        "name": "router",
        "description": "Routes message.inbound.# and cron.# to agents via agent.skill.request",
        "capabilities": ["message-routing", "skill-dispatch"],
        "publishes": ["agent.skill.request"],
        "subscribes": ["message.inbound.#", "cron.#"]
      }
    ],
    "topics": {
      "agent.skill.request": {
        "publishedBy": ["router", "ceremony"],
        "subscribedBy": ["skill-dispatcher"]
      }
    }
  }
}
```

Plugins that haven't yet declared `publishes` / `subscribes` show up with empty arrays — they're still loaded; they just don't contribute to the topic index.

---

## WS /api/bus/subscribe

External processes can join the bus over a WebSocket to observe topic traffic. See [external-bus-subscribers](../guides/external-bus-subscribers.md) for the full guide.

```
WS /api/bus/subscribe?topic=<pattern>[&apiKey=<key>]
```

**Auth**: API key (header `X-API-Key` or `?apiKey=` query param), gated when `WORKSTACEAN_API_KEY` is set.

Each matched bus message is delivered as a JSON frame:

```json
{ "topic": "<topic>", "correlationId": "<uuid>", "timestamp": 1748137622143, "payload": { ... } }
```

The channel is read-only. To publish from outside, use `POST /publish`.

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
      "executor": "deep-agent",
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

## GET /api/ceremonies

List ceremony definitions parsed from `workspace/ceremonies/*.yaml`.

**Auth**: API key. Agent-scoped callers see only their own ceremonies (`createdBy === caller.agentName`). Admin sees all.

**Query params**:
- `?all=true` — admin-only override: return every ceremony regardless of owner.

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

## GET /api/services

Service connectivity summary for the Overview dashboard. Checks env-var presence and (for Discord) the live client's `isReady()` state. **No envelope** — returns a raw object.

**Auth**: None

**Response** (`200`):
```json
{
  "discord":  { "configured": true, "connected": true, "bot": "Quinn#1234" },
  "github":   { "configured": true, "authType": "app" },
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
    "ava":        { "skills": ["chat"],                               "executorType": "deep-agent" },
    "protomaker": { "skills": ["sitrep", "plan", "manage_feature"],   "executorType": "a2a" },
    "quinn":      { "skills": ["pr_review", "bug_triage"],            "executorType": "a2a" }
  },
  "registrationCount": 6
}
```

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

## GET /.well-known/agent-card.json

Served by `src/api/agent-card.ts`. Exposes workstacean as an A2A-compliant agent — external agents fetch this URL to discover what skills they can dispatch. Skills are aggregated from the `ExecutorRegistry`, so any skill registered (yaml-declared + auto-discovered Phase 4 skills) shows up without a restart.

A legacy alias at `GET /.well-known/agent.json` returns the same body for clients that resolve the older path.

**Auth**: None (discovery is always public)

**Response** (`200`) — an [AgentCard](https://a2a-protocol.org/latest/specification/#agent-card):
```json
{
  "name": "workstacean",
  "description": "protoLabs Studio operational gateway...",
  "protocolVersion": "0.3.0",
  "version": "1.0.0",
  "url": "https://workstacean.example.com/a2a",
  "preferredTransport": "JSONRPC",
  "capabilities": { "streaming": true, "pushNotifications": true },
  "skills": [
    { "id": "plan", "name": "plan", "description": "...", "tags": ["routed", "ava"] },
    { "id": "bug_triage", "name": "bug_triage", "description": "...", "tags": ["routed", "quinn"] }
  ]
}
```

`url` is the canonical A2A endpoint that spec-compliant clients hit after card discovery. Resolution order:

1. `WORKSTACEAN_PUBLIC_BASE_URL` — operator-set canonical public base (e.g. `https://ava.proto-labs.ai`). When set, the card advertises `${WORKSTACEAN_PUBLIC_BASE_URL}/a2a`.
2. Otherwise, `http://${WORKSTACEAN_INTERNAL_HOST ?? "workstacean"}:${WORKSTACEAN_HTTP_PORT ?? 3000}/a2a` — the docker-network service name + the actual API port.

`additionalInterfaces` mirrors the same URL under the explicit `JSONRPC` transport so clients that walk the interfaces list can pick deterministically. `WORKSTACEAN_BASE_URL` is **not** consulted here — that variable is the externally-reachable URL stamped into A2A push-notification callbacks (see Env Vars), not the agent card.

---

## POST /a2a

A2A JSON-RPC 2.0 endpoint. Accepts every method in the A2A protocol (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`, `tasks/pushNotificationConfig/*`) and bridges them into the internal bus pipeline via `BusAgentExecutor` (`src/api/a2a-server.ts`).

**Auth**: When `WORKSTACEAN_API_KEY` is set, callers must supply it as `Authorization: Bearer <key>` or `X-API-Key: <key>`. Unset → open access (dev mode).

**Flow for `message/send`**:
1. SDK `JsonRpcTransportHandler` receives the request
2. `BusAgentExecutor.execute()` emits an initial `submitted` Task event, transitions to `working`, publishes to `agent.skill.request` on the bus
3. `SkillDispatcherPlugin` resolves an executor via `ExecutorRegistry` and runs the skill
4. Response lands on `agent.skill.response.{taskId}` → adapter emits a terminal `completed`/`failed` status update with the text in `status.message.parts`
5. Response returns as `{ jsonrpc: "2.0", id, result: <Task> }`

`message/stream` uses the same pipeline but returns a `text/event-stream` where each `data:` frame is a JSON-RPC response wrapping one A2A event.

Skill routing: metadata fields control which skill is invoked.
- `metadata.skillHint` or `metadata.skill` — skill name, defaults to `"chat"`
- `metadata.targets` — array of agent names, passed through to `ExecutorRegistry.resolve()`

---

## POST /api/a2a/callback/:taskId

Push-notification webhook for long-running A2A tasks (Phase 3). External agents POST Task snapshots here when they reach terminal state (or at configurable checkpoints) so workstacean doesn't need to hold an HTTP connection open for minutes.

**Auth**: Per-task token passed as `Authorization: Bearer <token>` or `X-A2A-Notification-Token: <token>`. The token is generated per-task and registered with the agent when the skill is dispatched; workstacean looks it up by `taskId` in `TaskTracker`.

**Request body**: Full A2A `Task` object (not a delta).

**Response** (`200`): `{ "success": true }`

Non-terminal states just refresh `lastPolledAt`. `input-required` states raise a HITL request. Terminal states publish the response and untrack the task.

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

**Auth**: API key (admin or per-agent — see [Per-agent API keys](#per-agent-api-keys-multi-tenant-model))

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
  createdBy?: string;    // Admin-only override (ignored from agent-scoped callers)
}
```

`createdBy` is **stamped server-side** from the caller's identity:
- Agent-scoped key → `createdBy = <agentName>`, `createdBy` body field is ignored
- Admin key → `createdBy` defaults to `"system"`; admins may set the body field to attribute the ceremony to a specific agent

**Response** (`200`):
```json
{ "success": true, "data": { "id": "...", "createdBy": "quinn", "..." } }
```

---

## POST /api/ceremonies/:id/update

Update an existing ceremony. Merges fields into the existing YAML.

**Auth**: API key. Agent-scoped callers may only update ceremonies where `createdBy === caller.agentName`. Admin can update any.

**Path params**: `id` — ceremony ID

**Request body**: Same fields as create (all optional except `id`). `createdBy` is **stripped from the body** — ownership transfers are not supported via update.

**Errors**:
- `404` — ceremony not found
- `403` — agent-scoped caller is not the owner

---

## POST /api/ceremonies/:id/delete

Delete a ceremony. Removes the YAML file and unregisters from the scheduler.

**Auth**: API key. Agent-scoped callers may only delete their own ceremonies. Admin can delete any.

**Path params**: `id` — ceremony ID

**Errors**:
- `403` — agent-scoped caller is not the owner

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

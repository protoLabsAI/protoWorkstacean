---
title: HTTP API Reference
---

All HTTP endpoints exposed by protoWorkstacean. The server listens on `WORKSTACEAN_HTTP_PORT` (default `3000`).

## Authentication

Most read endpoints are unauthenticated. The `/publish` endpoint requires `X-API-Key: $WORKSTACEAN_API_KEY`.

---

## GET /health

Returns server health status.

**Auth**: None

**Response**:
```json
{ "status": "ok", "uptime": 42.3 }
```

Returns `503` if the server is not ready.

---

## POST /publish

Inject a message onto the event bus. This is the primary integration point for external callers.

**Auth**: `X-API-Key: $WORKSTACEAN_API_KEY`

**Request body**:
```typescript
{
  topic: string;           // Bus topic (e.g. "agent.skill.request")
  payload: unknown;        // Arbitrary payload — shape depends on topic
  correlationId?: string;  // Trace ID. Auto-generated if omitted.
  source?: {
    interface: string;
    channelId?: string;
    userId?: string;
  };
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
      "correlationId": "my-trace-001",
      "replyTopic": "agent.skill.response.my-trace-001"
    }
  }'
```

**Response**: `204 No Content` on success.

---

## POST /api/onboard

Onboard a new project into the system.

**Auth**: `X-API-Key: $WORKSTACEAN_API_KEY`

**Request body**:
```typescript
{
  owner: string;    // GitHub org or user
  repo: string;     // Repository name
  description?: string;
}
```

**Response**: `200 OK` with the created project entry.

---

## GET /api/projects

List all registered projects from `workspace/projects.yaml`.

**Auth**: None

**Response**:
```json
[
  {
    "slug": "my-project",
    "owner": "my-org",
    "repo": "my-repo",
    "discordChannels": ["1234567890"]
  }
]
```

---

## GET /api/agents

List all registered agents and their executor type and skills.

**Auth**: None

**Response**:
```json
[
  {
    "name": "ava",
    "type": "proto-sdk",
    "role": "orchestrator",
    "skills": ["sitrep", "plan", "triage"]
  },
  {
    "name": "quinn",
    "type": "a2a",
    "skills": ["bug_triage", "pr_review"]
  }
]
```

---

## GET /api/world-state

Return the current snapshot of all registered domains.

**Auth**: None

**Response**:
```json
{
  "board": {
    "name": "board",
    "data": { "efficiency": 0.47, "totalItems": 23 },
    "collectedAt": "2026-04-08T09:00:00.000Z",
    "metadata": { "failed": false, "httpStatus": 200 }
  },
  "ci": {
    "name": "ci",
    "data": { "successRate": 0.85 },
    "collectedAt": "2026-04-08T09:00:00.000Z",
    "metadata": { "failed": false, "httpStatus": 200 }
  }
}
```

---

## GET /api/world-state/:domain

Return the current snapshot for a single domain.

**Auth**: None

**Path parameters**:
- `domain` — domain name as registered (e.g. `board`, `ci`)

**Response**:
```json
{
  "name": "board",
  "data": { "efficiency": 0.47 },
  "collectedAt": "2026-04-08T09:00:00.000Z",
  "metadata": { "failed": false, "httpStatus": 200 }
}
```

Returns `404` if the domain is not registered.

---

## GET /api/ceremonies

List all loaded ceremony definitions.

**Auth**: None

**Response**:
```json
[
  {
    "id": "daily-standup",
    "name": "Daily Fleet Standup",
    "schedule": "0 9 * * 1-5",
    "skill": "board_audit",
    "enabled": true,
    "nextRun": "2026-04-09T09:00:00.000Z"
  }
]
```

---

## POST /api/ceremonies/:id/run

Manually trigger a ceremony outside its schedule.

**Auth**: `X-API-Key: $WORKSTACEAN_API_KEY`

**Path parameters**:
- `id` — ceremony ID (e.g. `daily-standup`)

**Response**: `200 OK` with `{ "triggered": true, "id": "daily-standup" }`.

Returns `404` if the ceremony is not found.

---

## GET /api/incidents

List all open security incidents.

**Auth**: None

**Response**:
```json
[
  {
    "id": "inc-001",
    "title": "Dependency vulnerability detected",
    "severity": "high",
    "status": "open",
    "reportedAt": "2026-04-08T08:00:00.000Z"
  }
]
```

---

## POST /api/incidents

Report a new security incident.

**Auth**: `X-API-Key: $WORKSTACEAN_API_KEY`

**Request body**:
```typescript
{
  title: string;
  description?: string;
  severity: "low" | "medium" | "high" | "critical";
}
```

**Response**: `201 Created` with the created incident object including its generated `id`.

---

## POST /api/incidents/:id/resolve

Mark an incident as resolved.

**Auth**: `X-API-Key: $WORKSTACEAN_API_KEY`

**Path parameters**:
- `id` — incident ID

**Response**: `200 OK` with `{ "resolved": true, "id": "inc-001" }`.

Returns `404` if the incident is not found.

---

## GET /api/goals

List all loaded goals and their current evaluation status.

**Auth**: None

**Response**:
```json
[
  {
    "id": "ci.success_rate_healthy",
    "type": "Threshold",
    "severity": "high",
    "status": "ok",
    "lastEvaluated": "2026-04-08T09:00:00.000Z"
  },
  {
    "id": "security.no_open_incidents",
    "type": "Invariant",
    "severity": "critical",
    "status": "violated",
    "lastEvaluated": "2026-04-08T09:00:00.000Z"
  }
]
```

---

## GET /api/skills/:agentName

List skills registered for a specific agent.

**Auth**: None

**Path parameters**:
- `agentName` — agent name (e.g. `ava`, `quinn`)

**Response**:
```json
[
  { "name": "sitrep", "description": "Generate a situational awareness report" },
  { "name": "plan", "description": "Build a feature plan from a PRD" }
]
```

Returns `404` if the agent is not registered.

---

## GET /api/flow-metrics

Return all flow efficiency metrics collected by the FlowMonitor plugin.

**Auth**: None

**Response**:
```json
{
  "success": true,
  "data": {
    "cycleTimeP50Ms": 86400000,
    "cycleTimeP90Ms": 259200000,
    "throughputPerWeek": 4.2,
    "wipCount": 3
  },
  "collectedAt": 1712563200000
}
```

Returns `503` if the flow-monitor plugin is not available.

---

## GET /api/flow-metrics/:metric

Return a single flow metric by name.

**Auth**: None

**Path parameters**:
- `metric` — metric name (e.g. `cycleTimeP50Ms`, `wipCount`)

**Response**: Same shape as `/api/flow-metrics` but `data` contains only the requested metric.

Returns `503` if the flow-monitor plugin is not available.

---

## GET /api/channels

List all channels loaded from `workspace/channels.yaml`.

**Auth**: None

**Response**:
```json
{
  "success": true,
  "data": [
    { "id": "general", "platform": "discord", "channelId": "1234567890", "description": "General updates" },
    { "id": "alerts",  "platform": "discord", "channelId": "9876543210", "description": "Alert notifications" }
  ]
}
```

---

## POST /api/channels

Register a new channel at runtime (without restarting).

**Auth**: `X-API-Key: $WORKSTACEAN_API_KEY`

**Request body**:
```typescript
{
  id: string;          // Logical channel name
  platform: string;    // "discord" | "slack" | "signal"
  channelId: string;   // Platform-specific channel/room ID
  description?: string;
}
```

**Response**: `200 OK` with `{ "success": true, "data": { ... } }`.

Returns `409` if a channel with that `id` already exists.

---

## GET /api/hitl/pending

List all pending Human-in-the-Loop approval requests.

**Auth**: None

**Response**:
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

---
title: A2A Runtime
---

`A2AExecutor` dispatches a skill to an external agent over HTTP using JSON-RPC 2.0. Every request carries distributed trace headers so spans link across service boundaries.

**Type string**: `a2a`
**Registered by**: `SkillBrokerPlugin` — one executor per agent in `workspace/agents.yaml`.

## How it works

1. `SkillBrokerPlugin` reads `workspace/agents.yaml` on startup and creates one `A2AExecutor` per remote agent entry
2. When `SkillDispatcherPlugin` routes a request to this executor, it:
   - POSTs a `message/send` JSON-RPC 2.0 request to the agent's URL
   - Sends trace headers (`X-Correlation-Id`, `X-Parent-Id`, `X-API-Key`)
   - Waits up to `timeoutMs` (default: 110,000 ms) for the response
   - Returns the agent's reply text as `SkillResult.text`

## Request shape

```json
{
  "jsonrpc": "2.0",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "<content or prompt>" }]
    },
    "contextId": "<correlationId>",
    "metadata": {
      "skillHint": "<skill>",
      "correlationId": "<correlationId>",
      "parentId": "<parentId>"
    }
  }
}
```

## HTTP headers sent

```
Content-Type: application/json
X-Correlation-Id: <correlationId>
X-Parent-Id: <parentId>   (if present)
X-API-Key: <resolved from apiKeyEnv>
```

## Agent YAML entry

```yaml
# workspace/agents.yaml
agents:
  # protoMaker team — multi-agent runtime for board ops, planning,
  # feature lifecycle. The AVA_* env vars keep their historical names
  # because they describe the HTTP server identity, not the agent slug.
  - name: protomaker
    type: a2a
    url: "${AVA_BASE_URL}/a2a"
    apiKeyEnv: AVA_API_KEY
    skills:
      - sitrep
      - board_health
      - manage_feature
      - bug_triage
      - plan

  - name: quinn
    type: a2a
    url: "${QUINN_BASE_URL}/a2a"
    apiKeyEnv: QUINN_API_KEY
    skills:
      - pr_review
      - bug_triage
      - security_triage
```

Environment variables are interpolated at registration time from the process environment.

## Constructor

```typescript
new A2AExecutor(config: {
  name: string;
  url: string;
  apiKeyEnv?: string;
  timeoutMs?: number;  // Default: 110_000ms
})
```

## When to use

Use `A2AExecutor` when:
- The agent runs in a separate service (protoMaker team, quinn, protoContent, frank, etc.)
- The agent needs its own container, resources, or deployment lifecycle
- The agent exposes a standard A2A `message/send` endpoint

Use [ProtoSdk](proto-sdk) instead for agents that run inside the workstacean process.

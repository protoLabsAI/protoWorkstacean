---
title: A2A Runtime
---

`A2AExecutor` dispatches skills to external agents over HTTP using the [A2A protocol](https://a2a-protocol.org/latest/specification/) (JSON-RPC 2.0). Supports multi-turn conversations via `contextId` + `taskId`, task lifecycle states, SSE streaming for long-running skills, and API key authentication.

**Type string**: `a2a`
**Registered by**: `SkillBrokerPlugin` — one executor per agent in `workspace/agents.yaml`.

## How it works

1. `SkillBrokerPlugin` reads `workspace/agents.yaml` on startup and creates one `A2AExecutor` per remote agent entry
2. When `SkillDispatcherPlugin` routes a request to this executor, it:
   - POSTs a `message/send` JSON-RPC 2.0 request to the agent's URL
   - Sends trace headers (`X-Correlation-Id`, `X-Parent-Id`, `X-API-Key`)
   - Parses the response including `taskId`, `contextId`, and `status.state`
   - Returns the agent's reply text plus A2A metadata in `SkillResult`

## Multi-turn conversations

A2A uses two identifiers for conversation continuity:

- **`contextId`** — groups related tasks in a logical conversation (session thread)
- **`taskId`** — identifies a specific stateful work unit within a context

On the first turn, omit both — the remote agent generates them. On follow-up turns, pass `contextId` and `taskId` from the previous response to continue the same task. The `chat_with_agent` bus tool handles this automatically.

### Task lifecycle states

The remote agent returns `result.status.state` indicating where the task is:

| State | Meaning |
|-------|---------|
| `working` | Agent is actively processing |
| `input-required` | Agent needs more information — send a follow-up |
| `completed` | Task finished successfully |
| `failed` | Task encountered an error |
| `canceled` | Client canceled the task |
| `rejected` | Agent refused the request |

Terminal states (`completed`, `failed`, `canceled`, `rejected`) do not accept further messages.

### Ending a conversation

Set `done: true` on the final `chat_with_agent` call. This omits `contextId` and `taskId` from the response, signaling that the conversation is closed and preventing the remote agent from looping with "anything else?" follow-ups.

## Request shape

```json
{
  "jsonrpc": "2.0",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "<content>" }]
    },
    "contextId": "<conversation thread ID>",
    "metadata": {
      "skillHint": "<skill>",
      "correlationId": "<trace ID>",
      "parentId": "<parent span ID>"
    }
  }
}
```

## Response shape

```json
{
  "jsonrpc": "2.0",
  "result": {
    "id": "<taskId>",
    "contextId": "<conversation thread ID>",
    "status": { "state": "completed" },
    "artifacts": [
      {
        "artifactId": "<uuid>",
        "parts": [{ "kind": "text", "text": "<agent response>" }]
      }
    ]
  }
}
```

The executor flattens all text parts across all artifacts into a single string. Fallback cascade: `artifacts.parts.text` → `result.message` → generic placeholder.

## HTTP headers

```
Content-Type: application/json
X-Correlation-Id: <trace ID>
X-Parent-Id: <parent span ID>   (if present)
X-API-Key: <from apiKeyEnv>     (if configured)
Accept: text/event-stream       (if streaming enabled)
```

## SSE streaming

When the agent card declares `capabilities.streaming: true`, the executor sends `message/sendStream` and reads Server-Sent Events:

- **TaskStatusUpdateEvent** — intermediate status changes with optional message
- **TaskArtifactUpdateEvent** — progressive artifact chunks

The `onStreamUpdate` callback emits these to the event bus as `agent.chat.inbound` events, enabling Discord o11y to show agent thinking in real time.

Falls back to blocking `message/send` when streaming is unavailable or the agent card says `streaming: false`.

## Authentication

Agents declare their security requirements in the agent card:

```json
{
  "securitySchemes": {
    "apiKey": { "type": "apiKey", "in": "header", "name": "X-API-Key" }
  },
  "security": [{ "apiKey": [] }]
}
```

The executor resolves the API key from the environment variable named in `apiKeyEnv` and sends it as `X-API-Key`.

## Agent card discovery

On startup, `SkillBrokerPlugin` fetches `GET /.well-known/agent.json` from each agent's base URL (5s timeout). The card's `skills` array is merged into the executor registry, allowing runtime skill discovery.

## Agent YAML entry

```yaml
# workspace/agents.yaml
agents:
  - name: quinn
    url: "${QUINN_BASE_URL}/a2a"
    skills:
      - name: pr_review
        description: Review PRs and submit formal APPROVE/REQUEST_CHANGES
      - name: bug_triage
        description: Triage bugs and file on the board
      - name: security_triage
        description: CVE/vulnerability triage and escalation

  - name: protomaker
    url: "${AVA_BASE_URL}/a2a"
    apiKeyEnv: AVA_API_KEY
    skills:
      - name: sitrep
      - name: board_health
      - name: manage_feature
      - name: bug_triage
```

Environment variables are interpolated at registration time.

## Constructor

```typescript
new A2AExecutor(config: {
  name: string;
  url: string;
  apiKeyEnv?: string;
  timeoutMs?: number;      // Default: 300_000 (5 min)
  streaming?: boolean;     // From agent card capabilities
  onStreamUpdate?: (update: { type: string; text?: string; state?: string }) => void;
})
```

## When to use

Use `A2AExecutor` when:
- The agent runs in a separate service (Quinn, protoMaker team, protoContent, Frank)
- The agent needs its own container, resources, or deployment lifecycle
- The agent exposes a standard A2A `message/send` endpoint

Use [DeepAgent](deep-agent) instead for agents that run inside the workstacean process via LangGraph.

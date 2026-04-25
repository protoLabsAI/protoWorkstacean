---
title: A2A Streaming (SSE)
---

How to add Server-Sent Events (SSE) streaming to an A2A agent so consumers get intermediate progress updates instead of blocking for the full response.

## Where streaming fits in the dispatch pipeline

All skill requests — whether triggered by a Discord DM, a Linear webhook, or an autonomous GOAP action — travel the same unified dispatch path:

```
inbound event
  → RouterPlugin
    → agent.skill.request (bus)
      → SkillDispatcherPlugin
        → ExecutorRegistry.resolve(skill, targets?)
          → A2AExecutor
```

Streaming is a transport detail at the `A2AExecutor` layer. If the agent's card declares `streaming: true`, the executor sends `message/stream` instead of `message/send` and reads the SSE response as it arrives. The caller — `SkillDispatcherPlugin`, the GOAP loop, Ava — does not know or care whether the underlying call was streaming or blocking. The result arrives on `replyTopic` either way.

## Overview

By default, A2A agents handle `message/send` — the executor blocks until the agent finishes. For long-running skills (deep research, multi-step triage), this creates dead air. SSE streaming solves this:

1. `A2AExecutor` sends `message/stream` instead of `message/send`
2. Agent returns `text/event-stream` with intermediate updates
3. Executor fires `onStreamUpdate` callbacks as events arrive (e.g. Discord o11y)
4. Agent sends final artifact + `[DONE]` to close the stream; executor publishes to `replyTopic`

## Agent-side setup

### 1. Declare streaming in your agent card

```python
AGENT_CARD = {
    "name": "my-agent",
    "capabilities": {"streaming": True},  # ← enables SSE
    # ...
}
```

### 2. Handle `message/stream` in your `/a2a` endpoint

Accept both `message/send` (blocking) and `message/stream` (SSE):

```python
from fastapi.responses import StreamingResponse
import json, asyncio, queue

@app.post("/a2a")
async def a2a_handler(req: dict):
    method = req.get("method", "")

    if method == "message/stream":
        return StreamingResponse(
            sse_generator(req),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    elif method == "message/send":
        return blocking_handler(req)
    else:
        return {"jsonrpc": "2.0", "error": {"code": -32601, "message": "Unknown method"}}
```

### 3. Emit SSE events

Each SSE line must be `data: <json>\n\n`. Three event types:

> **Critical — every event needs a `kind` discriminator.** `@a2a-js/sdk`'s `for await` loop routes by `kind`. Events without it are silently skipped and `A2AExecutor` sees the stream as empty. This is what Quinn #40 fixed. Wire fields are camelCase (`taskId`, `contextId`, `lastChunk`) — not snake_case.

**Initial snapshot** — the first frame is a full `Task` object with `kind: "task"`:
```json
data: {"kind": "task", "id": "task-uuid", "contextId": "conv-uuid", "status": {"state": "submitted", "timestamp": "..."}}
```

**TaskStatusUpdateEvent** — progress indicator:
```json
data: {"kind": "status-update", "taskId": "task-uuid", "contextId": "conv-uuid", "status": {"state": "working", "message": {"role": "agent", "parts": [{"kind": "text", "text": "Scanning HuggingFace..."}]}}, "final": false}
```

**TaskArtifactUpdateEvent** — partial result:
```json
data: {"kind": "artifact-update", "taskId": "task-uuid", "contextId": "conv-uuid", "artifact": {"artifactId": "task-uuid", "parts": [{"kind": "text", "text": "Found 3 relevant papers..."}]}, "append": true, "lastChunk": false}
```

**Completion** — emit TWO events: the final artifact-update, then a final status-update. `[DONE]` closes the stream:
```json
data: {"kind": "artifact-update", "taskId": "task-uuid", "contextId": "conv-uuid", "artifact": {"artifactId": "task-uuid", "parts": [{"kind": "text", "text": "Full research report..."}]}, "append": false, "lastChunk": true}

data: {"kind": "status-update", "taskId": "task-uuid", "contextId": "conv-uuid", "status": {"state": "completed", "timestamp": "..."}, "final": true}

data: [DONE]
```

### 4. Example SSE generator

```python
async def sse_generator(req):
    task_id = str(uuid.uuid4())
    context_id = req["params"].get("contextId", task_id)
    text = extract_text(req)

    # Frame 0: initial Task snapshot
    yield f"data: {json.dumps({'kind': 'task', 'id': task_id, 'contextId': context_id, 'status': {'state': 'submitted', 'timestamp': iso_now()}})}\n\n"

    # Run work with progress callback
    progress_q = queue.Queue()

    async def on_progress(msg):
        progress_q.put(msg)

    task = asyncio.create_task(do_work(text, on_progress))

    while not task.done():
        await asyncio.sleep(0.5)
        while not progress_q.empty():
            msg = progress_q.get_nowait()
            yield f"data: {json.dumps({'kind': 'status-update', 'taskId': task_id, 'contextId': context_id, 'status': {'state': 'working', 'message': {'role': 'agent', 'parts': [{'kind': 'text', 'text': msg}]}}, 'final': False})}\n\n"

    result = task.result()
    # Terminal: artifact-update FIRST (with the authoritative artifact),
    # then status-update with final=True.
    yield f"data: {json.dumps({'kind': 'artifact-update', 'taskId': task_id, 'contextId': context_id, 'artifact': {'artifactId': task_id, 'parts': [{'kind': 'text', 'text': result}]}, 'append': False, 'lastChunk': True})}\n\n"
    yield f"data: {json.dumps({'kind': 'status-update', 'taskId': task_id, 'contextId': context_id, 'status': {'state': 'completed', 'timestamp': iso_now()}, 'final': True})}\n\n"
    yield "data: [DONE]\n\n"
```

## Workstacean-side setup

### 1. Declare streaming in agents.yaml

```yaml
agents:
  - name: researcher
    url: "http://protoresearcher:7870/a2a"
    streaming: true    # ← enables SSE client
    skills:
      - name: deep_research
```

### 2. Discord o11y (optional)

Set `DISCORD_AGENT_OPS_CHANNEL` to a Discord channel ID. When streaming is active, intermediate SSE events are posted to this channel so you can watch agents think in real time.

The `SkillBrokerPlugin` wires the `onStreamUpdate` callback automatically when the channel is set.

## How it works end-to-end

```
Inbound message: "research full-duplex voice AI"
  → RouterPlugin → agent.skill.request (bus)
    → SkillDispatcherPlugin
      → ExecutorRegistry → A2AExecutor (streaming: true)
        → POST /a2a  method: message/stream
          ← text/event-stream:
              data: {"kind":"task", "id":"...", "contextId":"...", "status":{"state":"submitted"}}
              data: {"kind":"status-update", "taskId":"...", "status":{"state":"working","message":{...}}, "final":false}
              data: {"kind":"status-update", "taskId":"...", "status":{"state":"working","message":{...}}, "final":false}
              data: {"kind":"artifact-update", "taskId":"...", "artifact":{"artifactId":"...","parts":[...]}, "append":false, "lastChunk":true}
              data: {"kind":"status-update", "taskId":"...", "status":{"state":"completed"}, "final":true}
              data: [DONE]
        Each "working" event → onStreamUpdate → Discord agent-ops channel
        Final artifact → published to replyTopic
```

The caller receives the same `SkillResult` it would have received from a blocking call. Streaming is invisible above the executor layer.

## Task lifecycle states

| State | Meaning | Stream behavior |
|-------|---------|----------------|
| `working` | Agent processing | Emitted as progress updates |
| `input-required` | Agent needs human input | Stream pauses; HITL gate raised |
| `completed` | Done | Final artifact emitted, stream closes |
| `failed` | Error | Error message emitted, stream closes |

## input-required and HITL

If a streaming agent returns `input-required`, the task does not complete. `TaskTracker` detects the state, raises an `HITLRequest` on the bus, and the HITL renderer surfaces the pause point to a human on the originating interface. When the human responds, `TaskTracker` resumes the task via `message/send` with the same `taskId`. The agent picks up where it left off.

This is the same flow whether the request came from a human message or an autonomous GOAP action. See [HITL guide](./hitl) for the full flow.

## Fallback behavior

If the agent doesn't support streaming (card says `streaming: false` or omits it), `A2AExecutor` falls back to blocking `message/send`. No code changes needed on the caller side.

If the agent supports streaming but the SSE connection fails, the executor catches the error and falls back to `message/send` automatically.

## Artifact chunking

Agents can progressively stream a long artifact in multiple frames using `append` + `lastChunk` on `TaskArtifactUpdateEvent`:

- `append: false` (or omitted) → the incoming `parts` **replace** the buffer for that `artifactId`
- `append: true` → the incoming `parts` are **concatenated** to the existing buffer
- `lastChunk: true` → finalize the artifact; `A2AExecutor` fires `onStreamUpdate({ type: "artifact_complete", ... })`

This lets a researcher stream a 2000-word report as 20 × 100-word chunks. Each chunk surfaces live via `onStreamUpdate({ type: "artifact_chunk", ... })` to Discord, the dashboard, etc. The final concatenated text is what lands in the `SkillResult.text`.

## Long-running tasks

If your agent returns a non-terminal task (`working`, `submitted`, `input-required`) rather than a final result, `TaskTracker` polls `tasks/get` (or uses `tasks/resubscribe` for streaming agents) and publishes the response on the original `replyTopic` once terminal. No caller-side timeout tuning needed.

## Streaming progress out of workstacean (inbound A2A clients)

Everything above is about how `A2AExecutor` consumes a remote agent's stream. The reverse direction — when an external A2A client calls workstacean's `/a2a` endpoint and we want to surface intermediate progress to that caller — is wired through the bus with a single topic family.

### Topic contract

```
agent.skill.progress.{correlationId}
```

`BusAgentExecutor` (the A2A server adapter) subscribes to this topic on every inbound `message/send` or `message/stream` call alongside the reply topic. Each event published there is translated into an A2A `status-update` with `state: "working"` and `final: false`, sent over the SSE channel.

Payload shape:

```ts
interface AgentSkillProgressPayload {
  text?: string;                  // visible message body in the streamed update
  percent?: number;               // 0-100 progress
  step?: string;                  // named phase the executor is in
  meta?: Record<string, unknown>; // arbitrary structured progress
}
```

All fields are optional. The bus consumer only attaches a `message` body to the streamed `status-update` when `text` is set; `percent` / `step` / `meta` go into `status.metadata` for clients that render progress affordances rather than text.

### Opt-in publishing from a skill executor

A skill executor that wants to stream progress publishes during work:

```ts
bus.publish(`agent.skill.progress.${req.correlationId}`, {
  id: crypto.randomUUID(),
  correlationId: req.correlationId,
  topic: `agent.skill.progress.${req.correlationId}`,
  timestamp: Date.now(),
  payload: { text: "Searching project history…", percent: 25, step: "search" },
});
```

Executors that don't publish to this topic lose nothing — the existing `submitted → working → completed` lifecycle still works as before.

### Late-event safety

Progress events that arrive after the terminal reply (race with an unusually fast executor) are silently dropped — `BusAgentExecutor` tracks the settled state and unsubscribes both `agent.skill.progress.*` and `agent.skill.response.*` together on terminal / cancel. No leaked subscriptions across overlapping task ids.

### Consumer expectations

A streaming A2A client subscribed to `message/stream` previously saw:

```
submitted → working → ··· silence ··· → completed (full text)
```

Now sees (when the executor emits progress):

```
submitted → working → working (text="...") → working (percent=40, step="...") → ··· → completed
```

Same task lifecycle, real-time visibility into what the agent is doing.

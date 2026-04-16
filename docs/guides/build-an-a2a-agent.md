---
title: Build an A2A Agent
---

A recipe for building a new external A2A agent that plugs into Workstacean's routing, scheduling, and fleet-health pipelines. Complementary to [Add an agent](./add-an-agent), which covers the operator side (YAML + executor registration); this guide covers what to build on the **agent side** so everything else just works.

Reference implementations: [`protoPen/a2a_handler.py`](https://github.com/protoLabsAI/protoPen/blob/main/a2a_handler.py) and [`Quinn/a2a_handler.py`](https://github.com/protoLabsAI/quinn/blob/main/a2a_handler.py) — ~85% shared code, either one is a reasonable starting template.

## What you get for free

If you implement the A2A spec properly and serve an agent card with the right capability flags, Workstacean wires up the following automatically — no per-agent code on the Workstacean side:

| Feature | How it works |
|---|---|
| **Skill routing** | `SkillBrokerPlugin` discovers your skills from the card every 10 min |
| **Long-running task handling** | Return `Task.status.state = submitted` → `TaskTracker` polls every 30s until terminal |
| **Push notifications** | Advertise `capabilities.pushNotifications: true` → Workstacean registers a webhook per task, no more polling |
| **Fleet-health observability** | `TaskTracker.onTerminal` publishes `autonomous.outcome.{systemActor}.{skill}` on every task completion → `agent_fleet_health` aggregates per-agent success rate, p50/p95 latency, cost, failure reasons in a 24h rolling window |
| **Human-in-the-loop** | Return `input-required` → Workstacean raises a HITL prompt in Discord, resumes your task with the human's answer via `message/send` on the same `taskId` |
| **Scheduled invocations** | Define a ceremony YAML → Workstacean fires the skill at the scheduled time |

Your agent never writes a health probe, a retry loop, or a cron scheduler. Workstacean does those for every agent that joins the fleet.

## The minimum endpoint

At a minimum, expose four routes. The first three are the A2A spec; the fourth is how Workstacean discovers you.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/a2a` | JSON-RPC 2.0 — `message/send` + optionally `message/sendStream` |
| `GET` | `/tasks/{id}` | Poll the current task state |
| `POST` | `/tasks/{id}:cancel` | Cancel an in-flight task |
| `GET` | `/.well-known/agent-card.json` | Agent card (legacy clients hit `agent.json`; serve both) |

Three more are required if you advertise push notifications:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/tasks/{id}/pushNotificationConfigs` | Register a webhook for a task |
| `POST` | `/message:send` | REST alias for `message/send` (HTTP 202) |
| `POST` | `/message:stream` | REST alias for `message/sendStream` (SSE) |

### Task lifecycle

Every task moves through the A2A state machine:

```
submitted → working → completed
                   ↘ failed
                   ↘ canceled
                   ↘ input-required  (HITL — resumed via message/send on same taskId)
```

**Critical:** `message/send` must return `submitted` within ~1s. The full response comes later via polling, SSE, or webhook. If your handler blocks for the duration of the underlying skill, you lose:

- Timeout safety (reverse proxies cap HTTP connections, usually 60-300s)
- Cancellation (no way to interrupt a stuck task)
- Observability (no granular state updates; just "hanging")
- Push notifications (the whole point is "fire-and-forget on the caller side")

Spawn the skill execution as a background task owned by the task record, return a task receipt, let `TaskTracker` or SSE drive the result.

```python
async def _submit_task(text, context_id, push_config):
    task_id = str(uuid4())
    record = TaskRecord(id=task_id, state="submitted", ...)
    await store.create(record)
    record._bg_task = asyncio.create_task(_run_skill(task_id, text))
    return record  # returned immediately — state=submitted
```

## The agent card

```python
AGENT_CARD = {
    "name": "my-agent",
    "description": "One-line summary of what the agent does",
    "url": f"http://{host}/a2a",   # JSON-RPC endpoint, NOT the server root
    "version": "1.0.0",
    "provider": {"organization": "protoLabsAI"},
    "capabilities": {
        "streaming": True,                  # enables message/sendStream + :subscribe
        "pushNotifications": True,          # enables /tasks/{id}/pushNotificationConfigs
        "stateTransitionHistory": False,    # tracking every transition in the response
    },
    "defaultInputModes": ["text/plain"],
    "defaultOutputModes": ["text/markdown"],
    "skills": [
        {
            "id": "my_skill",
            "name": "My Skill",
            "description": "What this skill does, what input it expects",
            "tags": ["category"],
            "examples": ["/my-command", "do the thing"],
        },
    ],
    "securitySchemes": {
        "apiKey": {"type": "apiKey", "in": "header", "name": "X-API-Key"},
    },
    "security": [{"apiKey": []}],
}
```

Three field-level gotchas, all from incidents we've hit:

- **`url` must point at the JSON-RPC endpoint, not the server root.** `@a2a-js/sdk` uses this field to send `message/send` — if it's `http://host/`, FastAPI returns 405 and the dispatch dies silently. (See Quinn PR #6.)
- **Serve at both `/.well-known/agent-card.json` and `/.well-known/agent.json`.** Spec-canonical is `agent-card.json`; older clients use `agent.json`. Workstacean's `A2AExecutor` falls back from one to the other, but serving both saves a 404 round-trip.
- **Flip `capabilities.streaming` / `pushNotifications` to `true` only when you actually support them.** `SkillBrokerPlugin` refreshes the card every 10 min, and `A2AExecutor` switches transport (`sendMessageStream` vs `sendMessage`) based on those flags. False-positive flags break the dispatcher.

## Task store & hardening

Lessons the hard way — every agent's task store should handle the cases below. Steal from [`protoPen/a2a_handler.py`](https://github.com/protoLabsAI/protoPen/blob/main/a2a_handler.py) or [`Quinn/a2a_handler.py`](https://github.com/protoLabsAI/quinn/blob/main/a2a_handler.py) directly.

### 1. Terminal-task TTL eviction

A long-running process leaks memory proportional to total lifetime traffic if you never drop completed tasks. Run a background sweep that evicts terminal tasks older than N (we use 1h by default — long enough for pollers and webhook delivery to drain). Never evict `submitted` or `working` tasks.

### 2. Strong references on webhook delivery tasks

`asyncio.create_task(_deliver_webhook(...))` without retaining the handle is a trap — [Python 3.11+ docs](https://docs.python.org/3/library/asyncio-task.html#asyncio.create_task) warn the event loop keeps only weak references. A pending retry can be garbage-collected mid-backoff. Keep a module-level `set[asyncio.Task]`, add each task on create, attach a `done_callback` that evicts on completion.

### 3. Atomic cancel

The naive sequence `state = await store.get(id); if state not terminal: await store.update(CANCELED)` races with the background runner. A worker can transition to `completed` between the read and the write, and you clobber a legitimate terminal state with `canceled`. Do the check and the write under the same lock.

### 4. SSRF guard on webhook URLs

Any client supplying `http://169.254.169.254/...`, `http://localhost/...`, or `http://10.0.0.1/...` as a push config target turns your agent into an internal network scanner. Before accepting a `PushNotificationConfig`:

- Reject non-http(s) schemes (`file://`, `javascript:`, `gopher:`, …)
- Resolve the hostname once and check every returned address
- Reject loopback, link-local, RFC1918, multicast, reserved, unspecified IPs
- Reject unresolvable hostnames outright

One-time resolution is not a defence against DNS rebinding — pin the resolved IP on the httpx transport if your threat model requires it. Private-network deployments (Tailscale-only, Docker-only) can skip this; public-internet deployments cannot.

### 5. Push config must be read from the live record, not closed over

`POST /tasks/{id}/pushNotificationConfigs` is explicitly a **post-submit** channel — callers who didn't have a webhook at submit time can register one later and still get terminal notifications. If your push helper closes over the submit-time config instead of reading `record.push_config` on every call, the post-submit registration silently does nothing.

```python
# Wrong — closes over submit-time config
def _make_push_fn(push_config):
    async def _push(record):
        if push_config and record.state in TERMINAL | {WORKING}:
            asyncio.create_task(_deliver_webhook(record, push_config))
    return _push

# Right — reads record.push_config at call time
async def _push(record):
    cfg = record.push_config
    if cfg and record.state in TERMINAL | {WORKING}:
        task = asyncio.create_task(_deliver_webhook(record, cfg))
        _pending_webhook_tasks.add(task)
        task.add_done_callback(_pending_webhook_tasks.discard)
```

### 6. Producer must be independent of the SSE connection

If your agent implements `message/sendStream`, the HTTP SSE generator and the LangGraph (or similar) producer should not be the same task. When the SSE client disconnects mid-run, FastAPI cancels the generator — if the producer is inline, it dies with the connection and any `:subscribe` reconnect has no task to attach to.

**Pattern:** always spawn the producer as a background task owned by the task record, regardless of which entry point created the task. The SSE generator becomes a pure consumer that reads from the store and awaits the rotating `_update_event`. Drop the SSE connection → producer keeps running → reconnect via `:subscribe` picks up cleanly.

```python
# Shared consumer used by both message/sendStream and :subscribe
async def _watch_task(task_id, start_text_len=0):
    record = await _store.get(task_id)
    if record is None:
        return
    last_sent_len = start_text_len
    yield ("status", record, None)
    if record.accumulated_text and len(record.accumulated_text) > last_sent_len:
        yield ("text_delta", record, record.accumulated_text[last_sent_len:])
        last_sent_len = len(record.accumulated_text)
    if record.state in _TERMINAL:
        return
    while True:
        r = await _store.get(task_id)
        if r is None:
            return
        try:
            await asyncio.wait_for(r._update_event.wait(), timeout=25)
        except asyncio.TimeoutError:
            yield ("keepalive", None, None)
            continue
        r = await _store.get(task_id)
        if r is None:
            return
        yield ("status", r, None)
        if r.accumulated_text and len(r.accumulated_text) > last_sent_len:
            yield ("text_delta", r, r.accumulated_text[last_sent_len:])
            last_sent_len = len(r.accumulated_text)
        if r.state in _TERMINAL:
            return
```

Both SSE routes catch `asyncio.CancelledError` (FastAPI raises this on client disconnect), log the drop, and re-raise — the background task is never cancelled.

### 7. Emit text deltas, not the full accumulated text

On `:subscribe` reconnect, the initial snapshot can emit the full `accumulated_text` once as an `append: false` frame. Every subsequent update must emit **only the new suffix** as `append: true`. Clients that receive the full text on every update see duplicated content on the wire (the subscribe snapshot already gave them the pre-disconnect portion). Track `last_sent_len` in your consumer and emit `text[last_sent_len:]`.

### 8. Persist tool-progress messages on the record

If the producer emits in-process events like `tool_start` / `tool_end` that your SSE path currently surfaces as status messages, those are invisible to a `:subscribe` reconnect — the subscriber reads the store, not the producer's event queue. Store the most recent tool message on the task record (e.g. `record.last_status_message: str | None`) via your `update_state(status_message=...)` call. Surface it under `status.message` in status events. Clear on terminal transitions so subscribers on a completed task see the final state cleanly.

## Streaming (optional)

See [A2A Streaming (SSE)](./a2a-streaming) for the full SSE event protocol. Short version: advertise `capabilities.streaming: true`, accept `method: "message/sendStream"` on `/a2a` and `POST /message:stream`, emit `text/event-stream` frames as work progresses. `A2AExecutor` on Workstacean's side switches transport automatically based on the card; your `message/send` consumers stay unchanged.

Terminal frames (`COMPLETED`) should carry the authoritative full artifact — text + any [worldstate-delta](../extensions/worldstate-delta-v1) DataParts — as `append: false, last_chunk: true`. Mid-run stays incremental via `append: true` text deltas only.

## Push notifications

Workstacean registers webhooks of the form `${WORKSTACEAN_BASE_URL}/api/a2a/callback/{taskId}` with a per-task HMAC token. When you POST a task snapshot to the URL, Workstacean verifies the token and fires the same bus event a poll would have.

The webhook payload should be a `TaskStatusUpdateEvent`:

```json
{
  "task_id": "3f8a1c2d-...",
  "context_id": "engagement-001",
  "status": {"state": "completed", "timestamp": "2026-04-15T20:00:00Z"},
  "artifact": {
    "parts": [{"kind": "text", "text": "## Results\n..."}],
    "append": false,
    "last_chunk": true
  }
}
```

Fire webhooks on **every** transition the caller cares about — `working`, `completed`, `failed`, `canceled`. Missing the cancel transition is a common bug (we fixed it in Quinn PR #19).

Implementation checklist:

- Retry delivery 3× with exponential backoff (1s / 3s / 9s)
- Skip retry on 4xx — the caller doesn't want it and retrying won't help
- Send `Authorization: Bearer <token>` if the caller registered a token
- Do NOT log the webhook body or token — these carry task artifacts, which may contain sensitive data

## Health = outcomes (automatic)

You do not need to expose a separate health endpoint. Workstacean's `TaskTracker` publishes an `autonomous.outcome.{systemActor}.{skill}` bus event on every terminal task:

```typescript
// protoWorkstacean/src/executor/skill-dispatcher-plugin.ts
onTerminal: (content, isError, taskState) => {
  this._publishAutonomousOutcome({
    correlationId, systemActor, skill,
    success: !isError,
    taskState,
    text: content,
    durationMs: Date.now() - dispatchedAt,
    usage,            // token counts if reported
  });
}
```

The `AgentFleetHealthPlugin` subscribes to `autonomous.outcome.#` and aggregates per-`systemActor` over a rolling 24h window: success rate, p50/p95 latency, cost per successful outcome, recent failures, orphaned-skill counts. Quinn, protoPen, the protoMaker team — every agent that returns async tasks appears in fleet health automatically.

**What to do on your side:** make sure `success = true` means "the agent achieved its goal," not "the skill returned without crashing." Classic mistake: a tool returns `"Error: ..."` but the agent reports `state: completed` with that string as an artifact. Fleet health now thinks every failure is a success. Propagate tool errors into the task state machine — return `state: failed, error: <msg>` when things go wrong.

## Scheduled work (ceremonies)

Two entry points — operator-driven and agent-driven.

### Operator side: define a ceremony YAML

Full schema is in [Create a Ceremony](./create-a-ceremony). Short version — drop a file in `workspace/ceremonies/<id>.yaml`:

```yaml
id: quinn.daily-digest
name: "Quinn Daily QA Digest"
schedule: "0 14 * * *"          # 5-field cron, UTC
skill: qa_report                 # must be on the target agent's card
targets: [quinn]
notifyChannel: "1469080556720623699"
enabled: true
```

Workstacean reloads `workspace/ceremonies/*.yaml` every ~5s, so no restart is needed to add or disable a ceremony.

When the cron fires:

1. `CeremonyPlugin`'s internal timer emits `ceremony.quinn.daily-digest.execute`
2. `CeremonyPlugin` publishes `agent.skill.request` with the ceremony's configured skill + targets
3. `SkillDispatcherPlugin` resolves the executor; `A2AExecutor` sends `message/send` to your `/a2a` with the skill content
4. Your agent runs the skill — the message text is whatever content the ceremony plugin built (usually a skill-specific prompt)

From the agent's perspective, a cron-triggered `message/send` looks identical to a Discord DM or any other inbound call. The only hint is `params.metadata.skillHint` which you can use for deterministic tool selection.

### Agent side: schedule from inside the agent

Agents with access to Workstacean's `manage_cron` tool can CRUD ceremonies programmatically — useful when the agent itself needs to set up a follow-up ("remind me to re-audit this PR in 30 minutes") or when the ceremony definition is dynamic.

The tool wraps these endpoints:

| Method | Path | Action |
|---|---|---|
| `GET` | `/api/ceremonies` | List |
| `POST` | `/api/ceremonies/create` | Create |
| `POST` | `/api/ceremonies/{id}/update` | Update |
| `POST` | `/api/ceremonies/{id}/delete` | Delete |
| `POST` | `/api/ceremonies/{id}/run` | Manual fire (ignores schedule) |

Auth via `X-API-Key`. **Use the per-agent key** (`WORKSTACEAN_API_KEY_<AGENT>`) rather than the shared admin key — ceremonies stamp `createdBy: <agent>` on the row, and per-agent keys enforce ownership on update/delete. See [Quinn's `manage_cron.py`](https://github.com/protoLabsAI/quinn/blob/main/tools/manage_cron.py) for a ~250-line reference implementation.

Example body for `create`:

```json
{
  "id": "my-agent.hourly-sweep",
  "name": "Hourly Sweep",
  "schedule": "0 * * * *",
  "skill": "my_skill",
  "targets": ["my-agent"],
  "enabled": true
}
```

**ID validation:** `^[\w.\-]+$` — alphanumeric, dots, dashes. Reject bad IDs at the tool layer before the API does, same error message the server produces.

**On update — do not re-enable by default.** The tool must treat `enabled` as present-only on update requests (not pass it through unless the caller explicitly set it) — otherwise every update silently re-enables paused ceremonies. This bit us in Quinn PR #12; see the `enabled: bool | None = None` pattern in `tools/lg_tools.py::manage_cron` for the fix.

## Gold-standard checklist

A protoAgent that ticks all of these is a first-class fleet citizen — routing, streaming, scheduling, observability, and planner ranking all work without any Workstacean-side tailoring:

### Transport & lifecycle
- [ ] `GET /.well-known/agent-card.json` + `/.well-known/agent.json` both serve the card
- [ ] `capabilities.streaming: true` matches a real `message/sendStream` implementation
- [ ] `capabilities.pushNotifications: true` matches a real `POST /tasks/{id}/pushNotificationConfigs` implementation
- [ ] `message/send` returns a `Task` with `state: submitted` in under 1s (never blocks on work)
- [ ] `GET /tasks/{id}` reflects current state + artifact
- [ ] `POST /tasks/{id}:cancel` is atomic and fires a push notification
- [ ] `GET /tasks/{id}:subscribe` can reattach to an in-flight task after SSE disconnect

### Task store hygiene
- [ ] Terminal tasks evict on a TTL (default 1h)
- [ ] Webhook delivery tasks have strong references (Python 3.11 GC trap)
- [ ] Cancel is an atomic `check-and-write` under the lock
- [ ] Webhook URLs pass SSRF validation (loopback / RFC1918 / link-local rejected)
- [ ] Push config read from the live record on every delivery, not closed over
- [ ] Background producer runs independently of any SSE connection

### SSE semantics
- [ ] Text deltas only on `append: true` — never the full `accumulated_text`
- [ ] Terminal frame is the authoritative full artifact, `append: false, last_chunk: true`
- [ ] Tool status messages persist on the record for `:subscribe` to surface
- [ ] Consumer disconnect does not cancel the producer

### Extensions (cards + runtime)
- [ ] [`effect-domain-v1`](../extensions/effect-domain-v1) declared on the card for every state-mutating skill (enables L1 planner ranking)
- [ ] [`worldstate-delta-v1`](../extensions/worldstate-delta-v1) DataPart emitted on the terminal task whenever a tool with known effects succeeds (declared effects must agree with observed deltas — a drift test is cheap)
- [ ] [`cost-v1`](../extensions/cost-v1) `{usage, durationMs, costUsd}` populated on the terminal task
- [ ] [`confidence-v1`](../extensions/confidence-v1) `{confidence, explanation}` populated when the agent can self-assess
- [ ] Success contract: `state: completed` means the agent actually achieved the goal, not just that the skill returned without crashing

## Reference implementations

- **[`Quinn/a2a_handler.py`](https://github.com/protoLabsAI/quinn/blob/main/a2a_handler.py)** — the most complete reference. All of the hardening above + decoupled SSE producer + delta-only text frames + tool-message persistence. Single 800-line file, no inheritance.
- **[`Quinn/server.py`](https://github.com/protoLabsAI/quinn/blob/main/server.py)** — agent-side wiring. `_chat_langgraph_stream` maps LangGraph `astream_events(v2)` to the `(tool_start|tool_end|text|delta|done|error)` tuple contract the handler consumes. `_build_agent_card` shows `capabilities.extensions` with `effect-domain-v1`. `_worldstate_delta_for_tool` emits the runtime delta on `file_bug` success.
- **[`Quinn/tools/manage_cron.py`](https://github.com/protoLabsAI/quinn/blob/main/tools/manage_cron.py)** — LangGraph tool that CRUDs ceremonies via the per-agent `X-API-Key`.
- **[`Quinn/tests/test_a2a_handler.py`](https://github.com/protoLabsAI/quinn/blob/main/tests/test_a2a_handler.py)** — ~55 tests covering the store, background runner, SSRF, cancel races, webhook retention, subscribe reconnect, delta-only text, producer survives consumer cancellation. Clone this alongside the handler.
- **[`protoPen/a2a_handler.py`](https://github.com/protoLabsAI/protoPen/blob/main/a2a_handler.py)** — original port target. Predates Quinn's hardening; lacks decoupled SSE producer, SSRF guard, webhook retention, atomic cancel. Kept as a reference for the minimum viable spec surface, but new agents should mirror Quinn's version.

## Related

- [Add an agent](./add-an-agent) — operator-side YAML + executor wiring
- [A2A Streaming (SSE)](./a2a-streaming) — SSE event protocol in detail
- [Create a Ceremony](./create-a-ceremony) — ceremony YAML schema
- [Workspace files reference](../../reference/workspace-files)
- [`effect-domain-v1`](../extensions/effect-domain-v1), [`worldstate-delta-v1`](../extensions/worldstate-delta-v1), [`cost-v1`](../extensions/cost-v1), [`confidence-v1`](../extensions/confidence-v1) — the four A2A extensions covered by the planner's ranking model

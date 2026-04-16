---
title: A2A Langfuse Trace Propagation
---

How distributed Langfuse tracing works across the protoLabs agent fleet. One Langfuse project, per-agent tags, cross-referenced trace IDs.

## Architecture decision

**One Langfuse project for the entire fleet**, not one per agent.

When Workstacean dispatches Quinn via A2A, and Quinn dispatches a subagent, the full chain should be visible in Langfuse without jumping between projects. Per-agent isolation is achieved with tags (`["quinn"]`, `["ava"]`, `["workstacean"]`), not project boundaries.

## The `a2a.trace` metadata convention

Every A2A `message/send` or `message/stream` call can carry the caller's Langfuse trace context in `params.metadata["a2a.trace"]`:

```json
{
  "jsonrpc": "2.0",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "Run a board audit" }]
    },
    "metadata": {
      "a2a.trace": {
        "traceId": "abc-123-langfuse-trace-uuid",
        "spanId": "def-456-current-span-uuid",
        "project": "protolabs"
      }
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `traceId` | yes | The Langfuse trace UUID from the caller's current scope |
| `spanId` | no | The specific span that dispatched this A2A call |
| `project` | no | Langfuse project name (future-proofing for multi-project setups) |

## How agents use it

### Receiving side (implemented in Quinn)

Quinn reads `params.metadata["a2a.trace"]` in `a2a_handler.py` and forwards it through:

```
a2a_handler → _submit_task(caller_trace=) → chat_stream_fn_factory(caller_trace=)
            → server._chat_langgraph_stream(caller_trace=)
            → tracing.trace_session(metadata={caller_trace_id, caller_span_id})
```

Quinn's Langfuse trace now carries `caller_trace_id` and `caller_span_id` in its metadata. An operator can filter Langfuse by `metadata.caller_trace_id = <uuid>` to find all agent traces spawned from a single Workstacean dispatch.

### Sending side (Workstacean — TODO)

`a2a-executor.ts` needs to stamp the current Langfuse trace context into outbound `params.metadata["a2a.trace"]`. The extension interceptor hook at line 221 is the natural injection point — extensions' metadata is already merged into outbound params.

## Cross-referencing in Langfuse

With this convention, a single Workstacean dispatch produces:

1. **Workstacean trace** — tagged `["workstacean"]`, spans: `a2a-dispatch → task-tracker-poll → ...`
2. **Quinn trace** — tagged `["quinn"]`, metadata: `caller_trace_id = <workstacean-trace-uuid>`

Search Langfuse by `metadata.caller_trace_id` to see all agent traces spawned from one orchestration run.

## Future: true parent-child nesting

The current implementation uses metadata cross-referencing. True nesting (Quinn's spans appear as children of Workstacean's span in one trace tree) requires:

1. Validate that `langfuse.trace(id=parent_trace_id)` followed by `trace.span(name=...)` nests correctly when called from a different process
2. If it works: Quinn calls `_langfuse.trace(id=caller_trace_id)` instead of creating a new trace, and her observations land directly in the caller's trace tree

This is tracked in [quinn#31](https://github.com/protoLabsAI/quinn/issues/31) (the OTel context cleanup issue is related).

## Adopting in a new agent

If you're building a new A2A agent per the [Build an A2A Agent](./build-an-a2a-agent) guide:

1. Read `params.metadata["a2a.trace"]` when parsing incoming `message/send` / `message/stream`
2. Forward `traceId` and `spanId` into your tracing system's metadata on the session/trace you open for this task
3. Tag your traces with your agent name (e.g. `["myagent"]`)
4. That's it — Langfuse cross-referencing works automatically

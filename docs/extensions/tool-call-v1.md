---
title: "Extension: x-protolabs/tool-call-v1"
---

`x-protolabs/tool-call-v1` is a **streaming progress construct**: per-tool lifecycle frames (`started → completed/failed`) emitted on the live A2A stream as `artifact-update` DataParts, so a rich client can render which tool an agent is running mid-task and how each invocation resolves.

**Extension URI**: `https://proto-labs.ai/a2a/ext/tool-call-v1`
**MIME type** (DataPart discriminator): `application/vnd.protolabs.tool-call-v1+json`

---

## What makes it different from the other extensions

The other four extensions ([cost-v1](cost-v1), [confidence-v1](confidence-v1), [blast-v1](blast-v1), [hitl-mode-v1](hitl-mode-v1)) are **interceptors**: they hook the `A2AExecutor` dispatch pipeline with `before` / `after` hooks, and gate on whether an agent declared the URI in its card. They observe or stamp a single terminal exchange.

tool-call-v1 is **not** an interceptor. It is not declared with `before` / `after` hooks, and it is not a terminal-artifact telemetry payload. It rides the **live SSE stream** while the task is still `working`: each frame is its own `artifact-update` event, emitted the moment a tool turn streams out of the agent's reasoning loop. There is no dispatch-pipeline registration for it — the frames originate inside the in-process runtime and flow over the bus to the A2A server, which emits them on the wire.

Think of it as the structured sibling of the plain-text `status.message` narration described in [A2A Streaming](../guides/a2a-streaming): same live stream, but a machine-readable tool timeline instead of a humanized sentence.

---

## Payload shape

A single frame describes one tool invocation. The payload is a discriminated union on `phase`, so each phase carries only its relevant field. Multiple frames sharing a `toolCallId` describe that invocation's lifecycle.

```ts
interface ToolCallFrameBase {
  toolCallId: string;   // stable id correlating frames of the same invocation
  name: string;         // tool name (e.g. "github_create_issue")
}

type ToolCallArtifactData =
  | (ToolCallFrameBase & { phase: "started";   args?: unknown })
  | (ToolCallFrameBase & { phase: "completed"; result?: unknown })
  | (ToolCallFrameBase & { phase: "failed";    error?: string });
```

- **`started`** — the agent's reasoning step requested this tool; `args` carries the parsed call arguments.
- **`completed`** — the tool returned; `result` carries its output.
- **`failed`** — the tool errored; `error` carries the message.

A consumer keys on `toolCallId` to stitch `started` to its later `completed` / `failed`, rendering a per-tool spinner that resolves to a check or an X.

---

## Emit / parse helpers

The contract lives in `packages/a2a/src/extensions.ts` (the TypeScript source of truth; the Python `protolabs-a2a` layer mirrors it):

```ts
import { emitToolCall, parseToolCall, TOOL_CALL_V1_MIME_TYPE } from "@protolabs/a2a";

// Build a DataPart for a streamed artifact-update.
const part = emitToolCall({ toolCallId, name: "pr_inspector", phase: "started", args });

// Extract the first tool-call-v1 payload from a parts array, or undefined.
const frame = parseToolCall(parts);
```

`emitToolCall` builds a spec-correct A2A 1.0 DataPart: the structured payload lives in `content.value`, and the discriminator rides on `metadata.mimeType` (not the SDK's transport-level `mediaType`, which stays `application/json`). `parseToolCall` scans a parts array for the first part whose `metadata.mimeType` matches the MIME constant and returns its payload.

---

## How a frame reaches the wire

The frames are produced by the in-process `DeepAgentExecutor` and bridged to the A2A server over the bus. The path:

1. **Emit (executor).** `DeepAgentExecutor` streams the LangGraph agent with `agent.stream(..., { streamMode: "values" })` rather than `invoke()`-ing it, so tool turns surface live as they stream in. `extractToolFrames` scans each newly-streamed message: a `started` frame per tool call on an AI message (keyed by the call's `id`), and a `completed` / `failed` frame per tool-result message. Each frame fires the executor's `onToolFrame` callback.

2. **Bridge (runtime plugin).** `AgentRuntimePlugin` wires `onToolFrame` to publish on the bus topic:

   ```
   agent.skill.toolframe.{correlationId}
   ```

   with payload `{ frame: ToolCallArtifactData }`.

3. **Emit on the stream (A2A server).** `BusAgentExecutor` (`src/api/a2a-server.ts`) subscribes to `agent.skill.toolframe.{correlationId}` for the duration of an inbound `message/send` / `message/stream` call. Each frame becomes an `artifact-update` event whose artifact (named `tool-call`) carries `emitToolCall(frame)`:

   ```ts
   eventBus.publish(AgentEvent.artifactUpdate({
     taskId, contextId,
     artifact: dataArtifact([emitToolCall(frame)], { name: "tool-call" }),
     append: false,
     lastChunk: false,
   }));
   ```

   The subscription is torn down together with the reply / progress / input subscriptions on terminal or cancel, so frames never leak across overlapping task ids, and late frames after settle are dropped.

---

## Two parallel channels — pick by client capability

A single in-process run feeds **two** streaming channels off the same tool turns:

| Channel | Topic | A2A surface | Reader |
|---|---|---|---|
| **Text narration** | `agent.skill.progress.{cid}` | `status-update` (state=`working`, `status.message`) | Simple clients |
| **Structured frames** | `agent.skill.toolframe.{cid}` | `artifact-update` DataPart (this extension) | Rich tool-timeline clients |

The narration channel carries a humanized one-liner (`routing to quinn`, `searching the web`) plus an initial `thinking` frame emitted the instant the graph starts — before the first LLM turn produces any tool call, so the caller sees motion during the model-latency window. The tool-call-v1 channel carries the machine-readable `started/completed/failed` frames in parallel.

A simple client reads `status.message` and ignores the artifact frames. A rich client reads the tool-call-v1 artifact frames to draw a live tool timeline. Neither blocks the other.

---

## Reference implementations

| Side | Where | Notes |
|---|---|---|
| **Contract** | [`packages/a2a/src/extensions.ts`](https://github.com/protoLabsAI/protoWorkstacean/blob/main/packages/a2a/src/extensions.ts) | MIME + URI constants, `ToolCallArtifactData` union, `emitToolCall` / `parseToolCall` |
| **Frame extraction** | [`src/executor/executors/deep-agent-executor.ts`](https://github.com/protoLabsAI/protoWorkstacean/blob/main/src/executor/executors/deep-agent-executor.ts) — `extractToolFrames` | Cursor-driven scan over streamed messages; fires `onToolFrame` per lifecycle event |
| **Bus bridge** | [`src/agent-runtime/agent-runtime-plugin.ts`](https://github.com/protoLabsAI/protoWorkstacean/blob/main/src/agent-runtime/agent-runtime-plugin.ts) — `_publishToolFrame` | Publishes `agent.skill.toolframe.{cid}` |
| **Wire emission** | [`src/api/a2a-server.ts`](https://github.com/protoLabsAI/protoWorkstacean/blob/main/src/api/a2a-server.ts) — `BusAgentExecutor` | Subscribes to the toolframe topic, emits `artifact-update` DataParts |

This channel is specific to the **in-process** runtime (DeepAgent). Remote A2A agents emit their own streaming frames over their own `/a2a` SSE response; this bus bridge is how workstacean's in-process agents reach parity with that on their own `/a2a` endpoint.

---

## Related

- [A2A Streaming (SSE)](../guides/a2a-streaming) — the streaming pipeline this rides on, including the `agent.skill.progress.{cid}` text-narration channel
- [Extend an A2A Agent](../guides/extend-an-a2a-agent) — the interceptor-style extensions (cost / confidence / blast / hitl-mode)
- [`cost-v1`](cost-v1) — terminal-task telemetry, by contrast a `before`/`after` interceptor

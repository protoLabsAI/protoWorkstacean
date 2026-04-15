---
title: Agent Session Model — SDK Session State and Continuation
---

_This is an explanation doc. It documents what `@protolabsai/sdk` currently exposes for session state and what a session-continuation RFC would need._

---

## What the SDK exposes today

All findings below are derived from `node_modules/@protolabsai/sdk/dist/index.d.ts`.

### Session IDs on every message

Every message type in the SDK union carries a `session_id: string` field:

| Type | Field |
|---|---|
| `SDKUserMessage` | `session_id: string` |
| `SDKAssistantMessage` | `session_id: string` |
| `SDKSystemMessage` | `session_id: string` |
| `SDKResultMessageSuccess` | `session_id: string` |
| `SDKResultMessageError` | `session_id: string` |
| `SDKPartialAssistantMessage` | `session_id: string` |

This means the session ID is always recoverable from any message in the stream, including the final result message.

### `query()` — session-related parameters

`query({ prompt, options })` accepts two session-related fields in `QueryOptions`:

```typescript
interface QueryOptions {
  /**
   * Resume a previous session by providing its session ID.
   * Equivalent to using the `--resume` flag in the CLI.
   */
  resume?: string;

  /**
   * Specify a session ID for the new session.
   * Ensures the SDK and CLI use the same session ID without resuming.
   * Equivalent to CLI's `--session-id` flag.
   */
  sessionId?: string;
}
```

**`resume`** is the continuation primitive. Pass the `session_id` captured from a previous run's result message to pick up where that session left off. The CLI loads its persisted conversation transcript and resumes from it.

**`sessionId`** assigns a known ID to a fresh session. Useful for deterministic session naming (e.g., keying sessions to a task or PR number) without replaying prior history.

### `Query` class — runtime access to session ID

The `Query` class (returned by `query()`) exposes:

```typescript
class Query implements AsyncIterable<SDKMessage> {
  getSessionId(): string;
}
```

This lets callers retrieve the live session ID at any point during a streaming run, without waiting for the final result message.

### What `query()` does NOT accept

- **No `messages` history array** — there is no parameter to inject a prior conversation as a messages array. Context replay is entirely CLI-side, loaded from the persisted session transcript on disk.
- **No `context` blob** — there is no field for passing arbitrary prior context (e.g., a JSON summary of previous turns).
- **No `parentSessionId`** — there is no branching or parent/child session graph concept.

---

## How session continuation currently works

Session state lives on the CLI's disk (the Claude / Qwen Code session transcript store). When `resume: sessionId` is passed:

1. The CLI process loads the stored transcript for that session ID.
2. The model receives the full prior conversation as context.
3. The new prompt is appended and execution continues.

The SDK itself is stateless between calls. It delegates all persistence to the CLI process.

---

## What a proto-sdk RFC would need

If the team wants richer session continuation control at the SDK layer — for example, injecting a trimmed context window, forking a session, or passing structured prior state — the current types do not support it. A future RFC would need to define:

### 1. Message history injection

A `messages` or `priorContext` field in `QueryOptions` allowing the caller to supply a messages array directly, bypassing disk-based replay. This is necessary for:

- Cross-machine session continuation (transcript not on the same host)
- Selective context pruning before resuming
- Testing/simulation without CLI state on disk

Candidate shape:

```typescript
interface QueryOptions {
  // Proposed addition:
  priorMessages?: Array<SDKUserMessage | SDKAssistantMessage>;
}
```

### 2. Session export from the result message

`SDKResultMessage` currently has `session_id` but no `transcript` or `messages` field. To support portable continuation, the result would need to optionally carry the full message log or a compact summary:

```typescript
interface SDKResultMessageSuccess {
  // Proposed addition:
  transcript?: Array<SDKUserMessage | SDKAssistantMessage>;
}
```

### 3. Session branching

A `forkFrom?: string` option to create a new session branched from a prior one at a specific turn index — useful for parallel exploration of alternatives from a common starting point.

---

## Summary

| Capability | Currently available | Notes |
|---|---|---|
| Resume from session ID | ✅ `options.resume` | CLI loads transcript from disk |
| Assign a session ID | ✅ `options.sessionId` | Fresh session, no replay |
| Read session ID at runtime | ✅ `query.getSessionId()` | Available immediately |
| Read session ID from result | ✅ `result.session_id` | On all message types |
| Inject prior messages | ❌ Not supported | RFC needed |
| Export transcript from result | ❌ Not supported | RFC needed |
| Fork / branch a session | ❌ Not supported | RFC needed |

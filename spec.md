# Personal Agent Stack — Spec

## One-line pitch
Text your infrastructure. It thinks, delegates, composes, and replies when done.

## What it is not
- Not a chatbot. Signal messages are triggers, not turns.
- Not a second brain. It produces artifacts, not archives.
- Not OpenClaw. Single user, local models, no plugin marketplace.

---

## Mental model

Signal is a trigger surface. Each inbound message is a pub. Each outbound reply is a sub delivery. Everything in between is async.

The agent is a wand, not an assistant. You cast a spell on a thing. The system resolves dependencies, executes, stores outputs, replies when done.

---

## Stack

| Layer | Component | Role |
|---|---|---|
| Interface | Signal (bbernhard REST API) | Inbound triggers, outbound replies |
| Agent | Pi SDK (`createAgentSession`) | ReAct loop, tool calling, session per user |
| Model | Qwen3.5-27B via Ollama | Local inference, thinking mode toggled per call |
| Bus | In-process EventEmitter | Pub/sub message passing between all components |
| Skills | Windmill scripts | Deterministic execution, dependency isolation, HTTP-triggered |
| Codegen | OpenCode (headless) | Generates new Windmill scripts when skill graph misses |
| Artifacts | MinIO | Blob storage for transcripts, summaries, derived outputs |
| State | SQLite | Event log, skill graph, session metadata |
| Speech | Kokoro REST | Optional TTS for voice note replies |
| Transcription | Whisper ASR REST | Voice note → text, audio URL → transcript |

---

## Architecture

```
Signal (inbound)
  → pub("agent", { message, sessionKey, correlationId })
    → Pi: reasons, identifies intent
      → skill graph hit: pub("skill.run", { name, params })
      → skill graph miss: pub("codegen", { task })
        → OpenCode: generates script → deploys to Windmill
          → pub("skill.registered", { name, webhookUrl })
            → retry intent

Windmill executes skill
  → large artifacts → MinIO
  → pub("skill.result", { payload | url, correlationId })
    → Pi: composes reply
      → pub("reply:+number", { text })
        → Signal (outbound)
```

Orchestrator subscribes to `skill.registered`, `skill.result`, `codegen` — coordinates fan-out and fan-in by correlationId. Stateless itself; all state in SQLite + MinIO.

---

## Skill graph

Not a registry. A DAG that emerges from execution history.

- Nodes: Windmill scripts with name, schema, webhookUrl, reliability score
- Edges: derived from correlationIds in the event log (skill A spawned skill B)
- Queries: `SELECT` over SQLite event log — no separate graph database needed
- Growth: opencode generates new nodes on cache miss; edges form naturally as skills compose

Pi queries the graph at `before_agent_start` via a lightweight semantic search over skill descriptions. Only relevant nodes are injected into context. The 27B never sees the full catalog.

---

## Context management

Pi sessions are **lean by design**.

- One JSONL session file per Signal number
- Async results injected only if correlationId matches active turn
- Background jobs (cron, proactive opencode) get fresh sessions, never pollute active conversation
- Heavy outputs (transcripts, code) live in MinIO; Pi receives URLs not blobs
- Thinking mode off for routing/classification, on for novel decomposition only

---

## Spell fulfillment (artifact model)

Spells are explicit, composable, dependency-aware.

- A spell is a Windmill script: idempotent, typed inputs/outputs, self-contained deps
- Artifacts are named outputs per job: `transcript.txt`, `tldr.md`, `tasks.md`
- Raw media is ephemeral (download → process → delete)
- Derived artifacts are durable (MinIO, referenced in SQLite)
- Downstream spells consume upstream artifacts; missing prereqs trigger upstream spell first
- "Skip if exists" is clean: check MinIO/SQLite, proceed or short-circuit

---

## Fan-out

Send "summarize these 5 links" → orchestrator fans to 5 parallel Windmill jobs → waits on 5 `skill.result` events by correlationId → Pi composes → one reply to Signal.

Parallelism is implicit. No orchestration changes. Actors just run.

---

## Multi-user (future)

Each additional user is:
- A Signal number (subscriber identity)
- A session key (Pi JSONL file)
- A debounce window on inbound messages

Windmill's job isolation handles skill execution boundaries. The bus handles routing. No architectural changes needed.

---

## Self-extension loop

```
agent: skill miss
  → opencode generates Windmill script
    → deployed via Windmill API
      → registered in skill graph
        → available for all future turns
```

The system grows its own capability. Each novel request that gets resolved becomes a compiled, reusable, reliable spell. Over time reasoning load shrinks; routing and execution dominate.

---

## Build order (vertical slices)

1. **Pi SDK CLI** — `createAgentSession` + Ollama/Qwen3.5, stdin/stdout, verify tool loop
2. **Windmill skill #1** — port whisper flow: audio URL → transcript + summary → MinIO
3. **Pi + Windmill tool** — `run_skill(name, params)` injected into Pi, hardcoded registry
4. **Signal bridge** — bbernhard WS listener → `session.prompt()` → `onBlockReply` → Signal reply; voice notes routed through whisper skill
5. **Event bus** — replace hardcoded calls with named pub/sub topics; orchestrator process
6. **Skill graph** — SQLite event log queries; graph-aware retrieval at `before_agent_start`
7. **Self-extension** — opencode tool; new scripts deployed to Windmill and registered automatically

Each slice delivers value before the next one starts.

---

## Invariants

- Signal carries signals, not blobs
- MinIO carries blobs, not signals  
- SQLite carries graph and history, not artifacts
- The bus carries events, not state
- Pi context stays lean; retrieval is the boundary
- Skills are deterministic; reasoning is reserved for the unknown
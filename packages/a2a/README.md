# `@protolabs/a2a`

**A thin conventions layer on top of the canonical [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) 1.0.**

The SDK owns the protocol — JSON-RPC transport, SSE streaming, agent-card
resolution, the task lifecycle. This package owns *only* the protoLabs
conventions that sit on top of it: four custom telemetry extensions, the agent
card defaults, the auth scheme, the bus-state boundary, and a handful of Part
helpers. Nothing in here re-implements protocol mechanics; if you find protocol
mechanics in here, that is a bug.

It is the TypeScript half of a matched pair. The Python half is
`protolabs-a2a` (on the official `a2a-sdk`). Both mirror the **same** extension
URIs, the **same** card conventions, and the **same** auth scheme, so the wire
contract cannot drift between a hub written in TS and an agent written in
Python.

> Design rationale: [ADR-0006 — A2A 1.0: Canonical SDKs + a Thin protoLabs
> Conventions Layer](../../docs/decisions/0006-a2a-1.0-canonical-sdks-and-protolabs-conventions-layer.md).
> Migration findings: [`docs/explanation/a2a-1.0-spike-findings.md`](../../docs/explanation/a2a-1.0-spike-findings.md).

---

## Why a separate layer?

A protocol bump is a breaking rewrite. A2A 0.3 → 1.0 renamed methods, made
`Part` member-discriminated, replaced kebab states with `TASK_STATE_*` enums,
dropped the `final` stream flag, and collapsed the agent card's transport fields
into `supportedInterfaces[]`. Across the fleet, four Python agents each
hand-rolled ~1–2k lines of A2A handler; a bump meant editing N near-identical
copies by hand.

The fix is: **adopt the canonical SDK in each language for the protocol, and
own one small shared package per language for the conventions.** That package is
this one. Agents import the SDK for mechanics and this layer for protoLabs glue
— and the glue is small enough to keep correct in both languages.

---

## The wire contract

### Parts (A2A 1.0, member-discriminated)

In 1.0 a `Part` is member-discriminated. There is **no** top-level
`kind`/`text`/`data` (that was 0.3). The content is a `$case`-tagged union:

```ts
{
  content:  { $case: "text" | "data" | "url" | "raw", value },
  metadata: { [k: string]: any } | undefined,
  filename: string,
  mediaType: string   // transport-level media type (e.g. "text/plain", "application/json")
}
```

`textPart`, `dataPart`, `partText`, `partData`, and `partsToText` keep that
discrimination in one place so callers never hand-assemble a Part.

### The four protoLabs extensions

Every protoLabs agent reports structured telemetry by attaching custom
**DataParts** to its terminal Task's artifacts (tool-call frames typically ride
on streamed artifact-update parts). Each extension is identified by a stable
MIME type carried in the part's **`metadata.mimeType`** — *not* in the SDK's
`mediaType`. The structured payload lives in **`content.value`**.

This split is deliberate: `mediaType` is the SDK's transport-level field and
stays `"application/json"` for all our DataParts; the protoLabs discriminator
rides on the application-level `metadata.mimeType`, keeping the extension
contract orthogonal to (and unbroken by) SDK typing changes. Consumers match on
`metadata.mimeType`, never on `mediaType`.

The canonical DataPart shape this package emits:

```jsonc
{
  "content":  { "$case": "data", "value": { /* payload, see below */ } },
  "metadata": { "mimeType": "<MIME constant>" },
  "filename": "",
  "mediaType": "application/json"
}
```

Each extension is also **declared** on the agent card's
`capabilities.extensions[]` under its URI (so peers can discover it), via
`protolabsExtensions()`.

| Extension | Card URI | DataPart `metadata.mimeType` |
|---|---|---|
| cost-v1 | `https://proto-labs.ai/a2a/ext/cost-v1` | `application/vnd.protolabs.cost-v1+json` |
| confidence-v1 | `https://proto-labs.ai/a2a/ext/confidence-v1` | `application/vnd.protolabs.confidence-v1+json` |
| worldstate-delta-v1 | `https://proto-labs.ai/a2a/ext/worldstate-delta-v1` | `application/vnd.protolabs.worldstate-delta+json` |
| tool-call-v1 | `https://proto-labs.ai/a2a/ext/tool-call-v1` | `application/vnd.protolabs.tool-call-v1+json` |

> The card URI and the per-part MIME discriminator are deliberately distinct
> forms (a URI for discovery, a `vnd.*+json` MIME for the part). Both are
> stable. Match parts by the MIME; advertise capability by the URI.

#### cost-v1 — observed skill cost + duration

`emitCost(data) → Part`, `parseCost(parts) → CostArtifactData | undefined`.

```jsonc
// content.value
{
  "usage": {
    "input_tokens": 1500,
    "output_tokens": 420,
    "cache_creation_input_tokens": 0,   // optional
    "cache_read_input_tokens": 120      // optional
  },
  "durationMs": 4200,    // optional — wall-clock ms
  "costUsd": 0.0123,     // optional — if omitted, consumer computes from tokens
  "success": true        // optional — overrides taskState when present
}
```

#### confidence-v1 — self-reported confidence

`emitConfidence(data) → Part`, `parseConfidence(parts) → ConfidenceArtifactData | undefined`.

```jsonc
// content.value
{
  "confidence": 0.88,                              // [0,1]; consumers clamp out-of-range
  "explanation": "spec unambiguous; all tests pass", // optional
  "success": true                                  // optional — overrides taskState
}
```

#### worldstate-delta-v1 — observed world-state mutations

`emitWorldStateDelta(data) → Part`, `parseWorldStateDelta(parts) → WorldStateDeltaArtifactData | undefined`.

```jsonc
// content.value
{
  "deltas": [
    {
      "domain": "ci",                  // world-state domain
      "path": "data.blockedPRs",       // dot-path into the domain
      "op": "set",                     // "set" | "inc" | "push"
      "value": 3                       // "inc" requires a number
    }
  ]
}
```

#### tool-call-v1 — per-tool progress frames

`emitToolCall(data) → Part`, `parseToolCall(parts) → ToolCallArtifactData | undefined`.

```jsonc
// content.value
{
  "toolCallId": "tc_01",                 // correlates frames of one invocation
  "name": "github_create_issue",
  "phase": "started",                    // "started" | "completed" | "failed"
  "args": { "title": "..." },            // present on "started"
  "result": { "issueNumber": 42 },       // present on "completed"
  "error": "rate limited"                // present on "failed"
}
```

### AgentCard

`buildAgentCard(opts)` applies the protoLabs card conventions:

- a single `supportedInterfaces[]` entry, `protocolBinding: "JSONRPC"`,
  `protocolVersion: "1.0"`, `tenant: ""` (1.0 collapsed the old
  `url`/`preferredTransport`/`additionalInterfaces`/top-level `protocolVersion`
  into this list; the first entry is preferred),
- the `provider` block (`protoLabs AI` / `https://protolabs.ai`),
- the four extensions declared in `capabilities.extensions[]` (plus any
  `extraExtensions` the caller passes — e.g. HITL-mode or blast-radius
  declarations),
- the matching `securitySchemes` entry when `authScheme` is set,
- `text/plain` default input/output modes.

### Auth

Two schemes are in use across the fleet:

- `"apiKey"` — credential sent as `X-API-Key: <value>` (the default).
- `"bearer"` — credential sent as `Authorization: Bearer <value>`.

`stampAuthHeader(headers, scheme, value)` stamps the outbound header in place;
`securitySchemeFor(scheme)` builds the matching card `securitySchemes` entry so
the card advertises exactly the scheme it enforces. (`"hmac"` is reserved for an
extension interceptor and stamps no static header.)

### Bus-state boundary (TS-only)

The SDK speaks the `TaskState` enum; the protoLabs internal bus speaks
lowercase strings (`"working"`, `"completed"`, …). `stateToLegacyString(state)`,
`isTerminalState(state)`, `isErrorState(state)`, and `TERMINAL_STATES` are the
single mapper, keeping the enum contained to the A2A edge. The 1.0 `final`
stream flag is gone — terminal = a terminal `TaskState` plus stream closure.

This boundary is TS-only: Python agents are A2A peers, so they emit the enum on
the wire and never touch the bus string form.

---

## Public API

```ts
import {
  // Parts
  textPart, dataPart, partText, partData, partsToText,

  // cost-v1
  COST_V1_MIME_TYPE, COST_V1_EXTENSION_URI, emitCost, parseCost,
  type CostArtifactData, type CostArtifactUsage,

  // confidence-v1
  CONFIDENCE_V1_MIME_TYPE, CONFIDENCE_V1_EXTENSION_URI, emitConfidence, parseConfidence,
  type ConfidenceArtifactData,

  // worldstate-delta-v1
  WORLDSTATE_DELTA_MIME_TYPE, WORLDSTATE_DELTA_V1_EXTENSION_URI,
  emitWorldStateDelta, parseWorldStateDelta,
  type WorldStateDeltaArtifactData, type WorldStateDeltaEntry, type WorldStateDeltaOp,

  // tool-call-v1
  TOOL_CALL_V1_MIME_TYPE, TOOL_CALL_V1_EXTENSION_URI, emitToolCall, parseToolCall,
  type ToolCallArtifactData,

  // shared scan primitive
  dataPartByMime,

  // AgentCard
  buildAgentCard, protolabsExtensions, jsonRpcInterface,
  PROTOCOL_VERSION, PROTOLABS_PROVIDER, type AgentCardOptions,

  // Auth
  stampAuthHeader, securitySchemeFor, API_KEY_HEADER, type A2AAuthScheme,

  // Bus-state boundary
  stateToLegacyString, isTerminalState, isErrorState, TERMINAL_STATES,
} from "@protolabs/a2a";
```

---

## Status & packaging

Validated **in-place** in the workstacean spike (`feature/a2a-1.0-alpha-spike`)
via a tsconfig path alias (`@protolabs/a2a` → `packages/a2a/src/index.ts`); Bun
resolves the alias at runtime. Per ADR-0006 §7, this package moves to its own
repo `protoLabsAI/protolabs-a2a` and is consumed via git-dependency.

`@a2a-js/sdk` is a **peer dependency** (`1.0.0-alpha.0`) — the consuming app
pins the SDK; this layer rides on whatever it pins.

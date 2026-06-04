/**
 * @protolabs/a2a — the protoLabs A2A conventions layer.
 *
 * A thin wrapper on top of the canonical `@a2a-js/sdk` 1.0. The SDK owns the
 * protocol mechanics (JSON-RPC, SSE, card resolution, task lifecycle); this
 * package owns ONLY protoLabs specifics:
 *
 *   1. The four custom extensions (cost / confidence / worldstate-delta /
 *      tool-call) — MIME constants, URIs, payload types, emit + parse helpers.
 *   2. AgentCard defaults — provider, supportedInterfaces, declared extensions.
 *   3. The auth scheme — apiKey / bearer header stamping + card security scheme.
 *   4. The bus-state boundary — TaskState enum ↔ lowercase bus strings (TS-only).
 *   5. Part helpers — builders + readers for the 1.0 member-discriminated Part.
 *
 * See README.md for the full wire contract.
 */

// Part builders + readers (1.0 member-discriminated Part)
export { textPart, textArtifact, dataArtifact, dataPart, partText, partData, partsToText } from "./parts.ts";

// Structured skill results (output_schema → forced-finalizer DataPart)
export {
  emitSkillResult,
  readSkillResult,
  submitToolName,
  SUBMIT_TOOL_PREFIX,
  SUBMIT_TOOL_NAME_RE,
} from "./skill-result.ts";

// The four protoLabs extensions
export {
  // cost-v1
  COST_V1_MIME_TYPE,
  COST_V1_EXTENSION_URI,
  emitCost,
  parseCost,
  type CostArtifactData,
  type CostArtifactUsage,
  // confidence-v1
  CONFIDENCE_V1_MIME_TYPE,
  CONFIDENCE_V1_EXTENSION_URI,
  emitConfidence,
  parseConfidence,
  type ConfidenceArtifactData,
  // worldstate-delta-v1
  WORLDSTATE_DELTA_MIME_TYPE,
  WORLDSTATE_DELTA_V1_EXTENSION_URI,
  emitWorldStateDelta,
  parseWorldStateDelta,
  type WorldStateDeltaArtifactData,
  type WorldStateDeltaEntry,
  type WorldStateDeltaOp,
  // tool-call-v1
  TOOL_CALL_V1_MIME_TYPE,
  TOOL_CALL_V1_EXTENSION_URI,
  emitToolCall,
  parseToolCall,
  type ToolCallArtifactData,
  // shared scan primitive
  dataPartByMime,
} from "./extensions.ts";

// AgentCard defaults + conventions
export {
  PROTOCOL_VERSION,
  PROTOLABS_PROVIDER,
  protolabsExtensions,
  jsonRpcInterface,
  buildAgentCard,
  type AgentCardOptions,
} from "./agent-card.ts";

// Auth scheme
export {
  API_KEY_HEADER,
  stampAuthHeader,
  securitySchemeFor,
  type A2AAuthScheme,
} from "./auth.ts";

// Bus-state boundary (TS-only)
export {
  TERMINAL_STATES,
  isTerminalState,
  isErrorState,
  stateToLegacyString,
} from "./bus-state.ts";

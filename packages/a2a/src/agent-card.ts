/**
 * AgentCard defaults + the protoLabs card conventions.
 *
 * A protoLabs A2A node advertises itself with a 1.0 AgentCard that:
 *   - exposes a single JSONRPC interface via `supportedInterfaces[]` (1.0
 *     replaced the 0.3 `url`/`preferredTransport`/`additionalInterfaces`
 *     fields with this list; the first entry is preferred),
 *   - names protoLabs as the provider,
 *   - declares the four custom extensions in `capabilities.extensions[]`
 *     (so peers can discover that we emit cost / confidence / worldstate-delta
 *     / tool-call telemetry),
 *   - advertises its auth scheme in `securitySchemes`.
 *
 * This module is the single source for those conventions so every node's card
 * is shaped identically.
 */

import type { AgentCard, AgentExtension, AgentInterface, AgentProvider, AgentSkill } from "@a2a-js/sdk";
import {
  COST_V1_EXTENSION_URI,
  CONFIDENCE_V1_EXTENSION_URI,
  WORLDSTATE_DELTA_V1_EXTENSION_URI,
  TOOL_CALL_V1_EXTENSION_URI,
} from "./extensions.ts";
import { securitySchemeFor, type A2AAuthScheme } from "./auth.ts";

/** A2A protocol version (Major.Minor per spec §3.6) advertised per interface. */
export const PROTOCOL_VERSION = "1.0";

/** The protoLabs provider block. */
export const PROTOLABS_PROVIDER: AgentProvider = {
  organization: "protoLabs AI",
  url: "https://protolabs.ai",
};

/**
 * The four protoLabs extensions, declared as 1.0 `AgentExtension`s for the
 * card's `capabilities.extensions[]`. Each carries its stable URI and a
 * human-readable description; none are `required` (consumers degrade
 * gracefully when a part is absent).
 */
export function protolabsExtensions(): AgentExtension[] {
  return [
    {
      uri: COST_V1_EXTENSION_URI,
      description: "Reports observed skill cost: token usage, wall-clock duration, optional $USD.",
      required: false,
      params: undefined,
    },
    {
      uri: CONFIDENCE_V1_EXTENSION_URI,
      description: "Reports self-assessed confidence in the result, with optional explanation.",
      required: false,
      params: undefined,
    },
    {
      uri: WORLDSTATE_DELTA_V1_EXTENSION_URI,
      description: "Reports observed world-state mutations applied during the task.",
      required: false,
      params: undefined,
    },
    {
      uri: TOOL_CALL_V1_EXTENSION_URI,
      description: "Reports per-tool progress frames (started / completed / failed) during the task.",
      required: false,
      params: undefined,
    },
  ];
}

/** Build a single JSONRPC `supportedInterfaces[]` entry pinned to A2A 1.0. */
export function jsonRpcInterface(url: string, tenant = ""): AgentInterface {
  return {
    url,
    protocolBinding: "JSONRPC",
    protocolVersion: PROTOCOL_VERSION,
    tenant,
  };
}

export interface AgentCardOptions {
  /** Agent display name (e.g. "workstacean"). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Agent version (e.g. "1.0.0"). */
  version: string;
  /** Canonical A2A endpoint URL (the JSONRPC interface). */
  url: string;
  /** Skills this agent exposes. */
  skills: AgentSkill[];
  /** Whether the agent supports SSE streaming. Default: true. */
  streaming?: boolean;
  /** Whether the agent supports push notifications. Default: true. */
  pushNotifications?: boolean;
  /**
   * Auth scheme to advertise. When set, the matching `securitySchemes` entry is
   * emitted. When omitted, the card advertises no scheme (open / dev mode).
   */
  authScheme?: A2AAuthScheme;
  /** Tenant for the interface entry. Default: "" (single-tenant). */
  tenant?: string;
  /**
   * Extra extensions to declare on top of the four protoLabs extensions (e.g.
   * an agent's HITL-mode or blast-radius declarations). Merged after the four.
   */
  extraExtensions?: AgentExtension[];
}

/**
 * Build a protoLabs-conventions AgentCard. Applies the provider, the declared
 * extensions, the security scheme, and the single JSONRPC interface; callers
 * supply only their identity + skills.
 */
export function buildAgentCard(opts: AgentCardOptions): AgentCard {
  return {
    name: opts.name,
    description: opts.description,
    version: opts.version,
    supportedInterfaces: [jsonRpcInterface(opts.url, opts.tenant ?? "")],
    provider: PROTOLABS_PROVIDER,
    capabilities: {
      streaming: opts.streaming ?? true,
      pushNotifications: opts.pushNotifications ?? true,
      extensions: [...protolabsExtensions(), ...(opts.extraExtensions ?? [])],
    },
    securitySchemes: opts.authScheme ? securitySchemeFor(opts.authScheme) : {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: opts.skills,
    signatures: [],
  };
}

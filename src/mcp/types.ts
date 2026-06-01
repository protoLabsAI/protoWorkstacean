/**
 * MCP client tier types — trust tiers, capability grants, and server registration.
 *
 * Implements the MCP client tier from ADR-0004 P4. External MCP servers are
 * registered via workspace/mcp-servers.yaml or the management API. Each server
 * gets a trust tier and optional capability grants that gate what it can access.
 *
 * Trust tiers (protoAgent ADR 0001):
 *   - "builtin"  — ships with workstacean image; auto-trusted, no grants needed
 *   - "trusted"  — operator-approved; auto-registers but may need grants
 *   - "community" — third-party; requires explicit operator approval before tools activate
 *
 * Capability grants (operator-approved at add-time):
 *   - "network"     — allows outbound HTTP requests from the MCP server process
 *   - "secrets"     — allows access to environment-variable secrets
 *   - "filesystem"  — allows filesystem read/write beyond sandbox
 */

/** Trust tier for an MCP server. Controls auto-registration and grant requirements. */
export type TrustTier = "builtin" | "trusted" | "community";

/** Capability grants that can be approved for an MCP server. */
export type CapabilityGrant = "network" | "secrets" | "filesystem";

/** Transport type for connecting to the MCP server. */
export type McpTransport = "stdio" | "sse";

/**
 * Raw YAML shape for a single MCP server entry.
 */
export interface McpServerDef {
  /** Unique name — used as the agentName in executor registry. */
  name: string;

  /** Trust tier. Defaults to "community" if omitted. */
  trust?: TrustTier;

  /**
   * Transport type. "stdio" runs a local process; "sse" connects to a remote
   * SSE endpoint. Defaults to "stdio".
   */
  transport?: McpTransport;

  /**
   * Command to execute (stdio transport). E.g. ["npx", "-y", "@modelcontextprotocol/server-filesystem"].
   */
  command?: string[];

  /**
   * Arguments for the command (stdio transport). Merged with command if not
   * specified as part of it.
   */
  args?: string[];

  /**
   * Environment variables to pass to the MCP server process.
   * Supports ${ENV_VAR} interpolation.
   */
  env?: Record<string, string>;

  /**
   * SSE endpoint URL (sse transport). E.g. "http://localhost:3001/mcp".
   */
  url?: string;

  /**
   * Capability grants approved by the operator. Empty = no special access.
   * Required for "community" servers to activate.
   */
  grants?: CapabilityGrant[];

  /**
   * Tool name whitelist. If set, only these tools from the server will be
   * registered. If unset, all discovered tools are registered.
   */
  allowedTools?: string[];

  /**
   * Tool name blacklist. Higher priority than allowedTools.
   */
  excludeTools?: string[];

  /**
   * Whether this server is active. Disabled servers are not connected.
   * Defaults to true for "builtin" and "trusted", false for "community"
   * (requires operator approval).
   */
  enabled?: boolean;

  /** Human-readable description. */
  description?: string;
}

/**
 * Resolved MCP server config after validation and env interpolation.
 */
export interface McpServerConfig {
  name: string;
  trust: TrustTier;
  transport: McpTransport;
  /** Command + args as a single array (stdio). */
  command?: string[];
  env?: Record<string, string>;
  url?: string;
  grants: CapabilityGrant[];
  allowedTools?: string[];
  excludeTools?: string[];
  enabled: boolean;
  description?: string;
}

/**
 * Result of probing an MCP server for its available tools.
 */
export interface McpProbeResult {
  name: string;
  reachable: boolean;
  tools?: McpToolInfo[];
  latencyMs?: number;
  error?: string;
}

/**
 * Tool information discovered from an MCP server.
 */
export interface McpToolInfo {
  name: string;
  description?: string;
  /** JSON Schema input schema (if available). */
  inputSchema?: unknown;
}

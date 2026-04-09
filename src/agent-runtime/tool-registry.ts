/**
 * ToolRegistry — central store of workstacean-specific MCP tool definitions.
 *
 * Tools are registered at startup and passed to agent query sessions via
 * createSdkMcpServer(). Each agent receives a filtered subset based on the
 * tools[] whitelist in its YAML config.
 *
 * Registered tools are SDK-compatible (SdkMcpToolDefinition) and can also be
 * exposed directly on the workstacean MCP server for Claude Code agents.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { SdkMcpToolDefinition } from "@protolabsai/sdk";

export class ToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tools = new Map<string, SdkMcpToolDefinition<any>>();

  /**
   * Register a tool. Overwrites any existing tool with the same name.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(def: SdkMcpToolDefinition<any>): void {
    this.tools.set(def.name, def);
  }

  /**
   * Register multiple tools at once.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAll(defs: SdkMcpToolDefinition<any>[]): void {
    for (const def of defs) {
      this.register(def);
    }
  }

  /**
   * Return a single tool by name, or undefined if not found.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: string): SdkMcpToolDefinition<any> | undefined {
    return this.tools.get(name);
  }

  /**
   * Return all registered tool definitions.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all(): SdkMcpToolDefinition<any>[] {
    return Array.from(this.tools.values());
  }

  /**
   * Return only the tools in the given allowlist.
   * Unknown names are silently skipped.
   *
   * Usage:
   *   createSdkMcpServer({ name: "workstacean", tools: registry.forAgent(agentDef.tools) })
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  forAgent(allowedNames: string[]): SdkMcpToolDefinition<any>[] {
    return allowedNames
      .map(n => this.tools.get(n))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((t): t is SdkMcpToolDefinition<any> => t !== undefined);
  }

  /**
   * List all registered tool names.
   */
  names(): string[] {
    return Array.from(this.tools.keys());
  }

  get size(): number {
    return this.tools.size;
  }
}

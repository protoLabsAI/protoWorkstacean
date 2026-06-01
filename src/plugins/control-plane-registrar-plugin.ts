/**
 * ControlPlaneRegistrarPlugin — the sole writer of workspace config files for
 * control-plane mutations (ADR-0004 P2).
 *
 * The write API (src/api/agents-crud.ts) validates + serializes a mutation and
 * publishes a `command.agent.*` topic; this registrar is the only subscriber
 * and performs the atomic filesystem write. Keeping all mutations on the bus
 * makes them auditable in bus-history, and the resulting file change triggers
 * the agent-runtime hot-reload (P1), so the agent goes live within ~5s.
 *
 * This is the documented exemption to "no plugin writes another plugin's
 * state": a registrar operating on a shared resource (the workspace dir), not
 * calling another plugin's methods.
 *
 * Writes are synchronous (writeFileSync + renameSync; unlinkSync) so they
 * complete within the synchronous bus dispatch — the publishing API handler can
 * verify the result immediately after `publish()` returns.
 */

import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";

export class ControlPlaneRegistrarPlugin implements Plugin {
  name = "control-plane-registrar";
  description = "Sole writer of workspace config files for control-plane command.* mutations";
  capabilities = ["control-plane", "config-writer"];

  /** Writes are confined to these roots — a path-traversal guard. */
  private readonly agentsRoot: string;   // workspace/agents/   — in-process DeepAgents (P2)
  private readonly agentsdRoot: string;  // workspace/agents.d/ — A2A endpoints (P3)
  private subscriptionIds: string[] = [];

  constructor(workspaceDir: string) {
    this.agentsRoot = resolve(workspaceDir, "agents");
    this.agentsdRoot = resolve(workspaceDir, "agents.d");
  }

  install(bus: EventBus): void {
    this.subscriptionIds.push(
      bus.subscribe("command.agent.upsert", this.name, (msg) => this._write(this.agentsRoot, msg)),
      bus.subscribe("command.agent.remove", this.name, (msg) => this._delete(this.agentsRoot, msg)),
      bus.subscribe("command.a2a.upsert", this.name, (msg) => this._write(this.agentsdRoot, msg)),
      bus.subscribe("command.a2a.remove", this.name, (msg) => this._delete(this.agentsdRoot, msg)),
    );
  }

  uninstall(): void {
    this.subscriptionIds = [];
  }

  /** Guard: the target must resolve to a file directly inside `root`. */
  private _safe(file: string | undefined, root: string): string | null {
    if (!file) return null;
    const resolved = resolve(file);
    if (dirname(resolved) !== root) {
      console.warn(`[control-plane] refusing write outside ${root}: ${file}`);
      return null;
    }
    return resolved;
  }

  private _write(root: string, msg: BusMessage): void {
    const p = (msg.payload ?? {}) as { name?: string; file?: string; yaml?: string };
    const file = this._safe(p.file, root);
    if (!file || typeof p.yaml !== "string") return;
    try {
      if (!existsSync(root)) mkdirSync(root, { recursive: true });
      // Atomic: write a temp sibling then rename over the target.
      const tmp = `${file}.tmp-${msg.id}`;
      writeFileSync(tmp, p.yaml, "utf8");
      renameSync(tmp, file);
      console.log(`[control-plane] wrote "${p.name}" → ${file}`);
    } catch (err) {
      console.error(`[control-plane] write "${p.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private _delete(root: string, msg: BusMessage): void {
    const p = (msg.payload ?? {}) as { name?: string; file?: string };
    const file = this._safe(p.file, root);
    if (!file) return;
    try {
      if (existsSync(file)) unlinkSync(file);
      console.log(`[control-plane] removed "${p.name}" → ${file}`);
    } catch (err) {
      console.error(`[control-plane] remove "${p.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

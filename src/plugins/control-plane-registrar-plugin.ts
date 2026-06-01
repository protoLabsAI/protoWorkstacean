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

interface AgentUpsertPayload {
  name?: string;
  file?: string;
  yaml?: string;
}
interface AgentRemovePayload {
  name?: string;
  file?: string;
}

export class ControlPlaneRegistrarPlugin implements Plugin {
  name = "control-plane-registrar";
  description = "Sole writer of workspace config files for control-plane command.* mutations";
  capabilities = ["control-plane", "config-writer"];

  /** Writes are confined to this root — a path-traversal guard. */
  private readonly agentsRoot: string;
  private subscriptionIds: string[] = [];

  constructor(workspaceDir: string) {
    this.agentsRoot = resolve(workspaceDir, "agents");
  }

  install(bus: EventBus): void {
    this.subscriptionIds.push(
      bus.subscribe("command.agent.upsert", this.name, (msg) => this._onUpsert(msg)),
      bus.subscribe("command.agent.remove", this.name, (msg) => this._onRemove(msg)),
    );
  }

  uninstall(): void {
    this.subscriptionIds = [];
  }

  /** Guard: the target must resolve to a file directly inside the agents root. */
  private _safe(file: string | undefined): string | null {
    if (!file) return null;
    const resolved = resolve(file);
    if (dirname(resolved) !== this.agentsRoot) {
      console.warn(`[control-plane] refusing write outside ${this.agentsRoot}: ${file}`);
      return null;
    }
    return resolved;
  }

  private _onUpsert(msg: BusMessage): void {
    const p = (msg.payload ?? {}) as AgentUpsertPayload;
    const file = this._safe(p.file);
    if (!file || typeof p.yaml !== "string") return;
    try {
      if (!existsSync(this.agentsRoot)) mkdirSync(this.agentsRoot, { recursive: true });
      // Atomic: write a temp sibling then rename over the target.
      const tmp = `${file}.tmp-${msg.id}`;
      writeFileSync(tmp, p.yaml, "utf8");
      renameSync(tmp, file);
      console.log(`[control-plane] wrote agent "${p.name}" → ${file}`);
    } catch (err) {
      console.error(`[control-plane] upsert "${p.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private _onRemove(msg: BusMessage): void {
    const p = (msg.payload ?? {}) as AgentRemovePayload;
    const file = this._safe(p.file);
    if (!file) return;
    try {
      if (existsSync(file)) unlinkSync(file);
      console.log(`[control-plane] removed agent "${p.name}" → ${file}`);
    } catch (err) {
      console.error(`[control-plane] remove "${p.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

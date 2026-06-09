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
import { resolve, dirname, join } from "node:path";
import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { RegistrationStore } from "../storage/registration-store.ts";
import { logger } from "../../lib/log.ts";

const log = logger("control-plane-registrar");

export class ControlPlaneRegistrarPlugin implements Plugin {
  name = "control-plane-registrar";
  description = "Sole writer of workspace config files for control-plane command.* mutations";
  capabilities = ["control-plane", "config-writer"];

  /** Writes are confined to these roots — a path-traversal guard. */
  private readonly agentsRoot: string;     // workspace/agents/        — in-process DeepAgents (P2)
  private readonly agentsdRoot: string;    // workspace/agents.d/      — A2A endpoints (P3)
  private readonly mcpServersRoot: string; // workspace/mcp-servers.d/ — MCP servers (P4, ADR-0005)
  private readonly routesdRoot: string;    // workspace/routes.d/      — wiring routes (ADR-0008 P2)
  private subscriptionIds: string[] = [];

  /**
   * Durable store for runtime-written registrations (#850). Optional: when
   * absent the registrar behaves exactly as before (ephemeral agents.d/ only).
   * Only the `agents.d/` (a2a) root is persisted — `workspace/agents/` is
   * git-tracked and has a durable home already.
   */
  private readonly store: RegistrationStore | undefined;

  constructor(workspaceDir: string, store?: RegistrationStore) {
    this.agentsRoot = resolve(workspaceDir, "agents");
    this.agentsdRoot = resolve(workspaceDir, "agents.d");
    this.mcpServersRoot = resolve(workspaceDir, "mcp-servers.d");
    this.routesdRoot = resolve(workspaceDir, "routes.d");
    this.store = store;
  }

  install(bus: EventBus): void {
    // Re-materialize durable registrations into the (possibly freshly-cloned,
    // empty) agents.d/ cache BEFORE SkillBroker loads it. Registrar installs
    // ahead of the broker in src/index.ts, so this closes the redeploy gap.
    this._rematerialize();

    this.subscriptionIds.push(
      bus.subscribe("command.agent.upsert", this.name, (msg) => this._write(this.agentsRoot, msg)),
      bus.subscribe("command.agent.remove", this.name, (msg) => this._delete(this.agentsRoot, msg)),
      bus.subscribe("command.a2a.upsert", this.name, (msg) => this._write(this.agentsdRoot, msg)),
      bus.subscribe("command.a2a.remove", this.name, (msg) => this._delete(this.agentsdRoot, msg)),
      bus.subscribe("command.mcp.upsert", this.name, (msg) => this._write(this.mcpServersRoot, msg)),
      bus.subscribe("command.mcp.remove", this.name, (msg) => this._delete(this.mcpServersRoot, msg)),
      bus.subscribe("command.route.upsert", this.name, (msg) => this._write(this.routesdRoot, msg)),
      bus.subscribe("command.route.remove", this.name, (msg) => this._delete(this.routesdRoot, msg)),
    );
  }

  /** "a2a" for the agents.d/ root (the persisted kind); undefined otherwise. */
  private _persistKind(root: string): string | undefined {
    return root === this.agentsdRoot ? "a2a" : undefined;
  }

  /**
   * Restore persisted a2a registrations to agents.d/ on boot. Only writes files
   * that are missing — an already-present file (normal restart, files survived)
   * is left untouched. On a fresh clone, agents.d/ is empty, so every stored
   * registration is rewritten and the broker picks them up.
   */
  private _rematerialize(): void {
    if (!this.store) return;
    let restored = 0;
    for (const reg of this.store.all("a2a")) {
      const file = join(this.agentsdRoot, `${reg.name}.yaml`);
      if (this._safe(file, this.agentsdRoot) !== file) continue;
      if (existsSync(file)) continue;
      try {
        if (!existsSync(this.agentsdRoot)) mkdirSync(this.agentsdRoot, { recursive: true });
        writeFileSync(file, reg.yaml, "utf8");
        restored++;
      } catch (err) {
        log.error(`rematerialize "${reg.name}" failed`, { err });
      }
    }
    if (restored > 0) log.info(`restored ${restored} durable a2a registration(s) to agents.d/`);
  }

  uninstall(): void {
    this.subscriptionIds = [];
  }

  /** Guard: the target must resolve to a file directly inside `root`. */
  private _safe(file: string | undefined, root: string): string | null {
    if (!file) return null;
    const resolved = resolve(file);
    if (dirname(resolved) !== root) {
      log.warn(`refusing write outside ${root}: ${file}`);
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
      log.info(`wrote "${p.name}" → ${file}`);
      // Persist to the durable store so the registration survives a redeploy.
      const kind = this._persistKind(root);
      if (kind && p.name) this.store?.upsert(kind, p.name, p.yaml);
    } catch (err) {
      log.error(`write "${p.name}" failed`, { err });
    }
  }

  private _delete(root: string, msg: BusMessage): void {
    const p = (msg.payload ?? {}) as { name?: string; file?: string };
    const file = this._safe(p.file, root);
    if (!file) return;
    try {
      if (existsSync(file)) unlinkSync(file);
      log.info(`removed "${p.name}" → ${file}`);
      const kind = this._persistKind(root);
      if (kind && p.name) this.store?.remove(kind, p.name);
    } catch (err) {
      log.error(`remove "${p.name}" failed`, { err });
    }
  }
}

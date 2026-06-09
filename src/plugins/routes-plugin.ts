/**
 * RoutesPlugin — the runtime for ADR-0008 P2 wiring authoring.
 *
 * Loads `workspace/routes.d/` and, for each enabled route, subscribes to the
 * route's `when.topic` and republishes `agent.skill.request` with the route's
 * `then.skill`/`agent` when that topic fires. Hot-reloads on file change (a
 * canvas draw-edge writes a file via the registrar; this plugin picks it up
 * within the watch window — no restart).
 *
 * It is a pure bus participant (the Plugin contract): it holds no reference to
 * another plugin. Routes funnel into the *existing* `agent.skill.request`
 * chokepoint, so every dispatcher invariant (cooldown, target-registry guard,
 * synthetic-actor filter, destructive-verdict guard) still applies — no new
 * dispatch path. A route is one hop; multi-step logic is a P3 workflow.
 */

import { resolve } from "node:path";
import type { EventBus, BusMessage, Plugin } from "../../lib/types.ts";
import { WorkspaceWatcher } from "../../lib/workspace-watcher.ts";
import { loadRouteEntries, type RouteDefinition } from "../routes/route-definition.ts";
import { logger } from "../../lib/log.ts";

const log = logger("routes");

export class RoutesPlugin implements Plugin {
  name = "routes";
  description = "Loads workspace/routes.d/ and dispatches agent.skill.request on each route's trigger topic (ADR-0008 P2 wiring).";
  capabilities = ["wiring", "routing"];
  subscribes = ["routes.d/* trigger topics (dynamic)"];
  publishes = ["agent.skill.request"];

  private bus?: EventBus;
  private readonly routesdDir: string;
  /** Subscription ids for the live routes — torn down + rebuilt on every reload. */
  private routeSubs: string[] = [];
  private watcher?: WorkspaceWatcher;

  constructor(workspaceDir: string) {
    this.routesdDir = resolve(workspaceDir, "routes.d");
  }

  install(bus: EventBus): void {
    this.bus = bus;
    this._loadAndSubscribe();
    // Hot-reload: re-derive subscriptions whenever routes.d/ changes.
    this.watcher = new WorkspaceWatcher({
      dirs: [this.routesdDir],
      onChange: () => this._loadAndSubscribe(),
    });
    this.watcher.prime();
    this.watcher.start();
  }

  uninstall(): void {
    this.watcher?.stop();
    this._unsubscribeAll();
    this.bus = undefined;
  }

  private _unsubscribeAll(): void {
    if (this.bus) for (const id of this.routeSubs) this.bus.unsubscribe(id);
    this.routeSubs = [];
  }

  /** Tear down the live route subscriptions and rebuild them from routes.d/. */
  private _loadAndSubscribe(): void {
    if (!this.bus) return;
    this._unsubscribeAll();
    const routes = loadRouteEntries(this.routesdDir, (file, err) =>
      log.warn(`skipped malformed route "${file}": ${err instanceof Error ? err.message : String(err)}`),
    ).filter((r) => r.enabled !== false);
    for (const route of routes) {
      const id = this.bus.subscribe(route.when.topic, `routes:${route.name}`, (msg) => this._dispatch(route, msg));
      this.routeSubs.push(id);
    }
    log.info(`loaded ${routes.length} route(s) from routes.d/`);
  }

  /** A route fired: forward the trigger into agent.skill.request, wiring only. */
  private _dispatch(route: RouteDefinition, msg: BusMessage): void {
    if (!this.bus) return;
    const triggerPayload = (msg.payload ?? {}) as Record<string, unknown>;
    // Reuse the trigger's correlationId so the trace stitches end-to-end.
    const correlationId = msg.correlationId ?? crypto.randomUUID();
    this.bus.publish("agent.skill.request", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "agent.skill.request",
      timestamp: Date.now(),
      // Passthrough: the agent sees the original message; the route only sets
      // the skill + target. No transform (the D1/D5 boundary).
      payload: {
        ...triggerPayload,
        skill: route.then.skill,
        targets: route.then.agent ? [route.then.agent] : (triggerPayload.targets ?? []),
        routedBy: route.name,
      },
      source: { interface: "routes" },
    });
  }
}

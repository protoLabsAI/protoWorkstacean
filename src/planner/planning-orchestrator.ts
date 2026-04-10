/**
 * PlanningOrchestrator — wires PlannerPluginL0 and ActionDispatcherPlugin
 * into a cohesive planning workflow.
 *
 * Responsibilities:
 *   - Owns the ActionRegistry
 *   - Installs both plugins on the EventBus
 *   - Provides a single install/uninstall surface for the planning subsystem
 *   - Exposes introspection APIs for debugging
 */

import type { EventBus } from "../../lib/types.ts";
import { ActionRegistry } from "./action-registry.ts";
import { PlannerPluginL0, type PlannerPluginL0Config } from "../plugins/planner-plugin-l0.ts";
import {
  ActionDispatcherPlugin,
  type ActionDispatcherConfig,
} from "../plugins/action-dispatcher-plugin.ts";

export interface PlanningOrchestratorConfig {
  planner?: PlannerPluginL0Config;
  dispatcher?: ActionDispatcherConfig;
}

const DEFAULT_DISPATCHER_CONFIG: ActionDispatcherConfig = {
  wipLimit: 5,
  defaultTimeoutMs: 30_000,
};

export class PlanningOrchestrator {
  private readonly registry: ActionRegistry;
  private readonly planner: PlannerPluginL0;
  private readonly dispatcher: ActionDispatcherPlugin;
  private installed = false;

  constructor(config: PlanningOrchestratorConfig = {}) {
    this.registry = new ActionRegistry();
    const dispatcherConfig = config.dispatcher ?? DEFAULT_DISPATCHER_CONFIG;
    this.planner = new PlannerPluginL0(this.registry, config.planner);
    this.dispatcher = new ActionDispatcherPlugin(dispatcherConfig);
  }

  /** Install both plugins on the event bus. */
  install(bus: EventBus): void {
    if (this.installed) return;
    this.dispatcher.install(bus);
    this.planner.install(bus);
    this.installed = true;
  }

  /** Uninstall both plugins. */
  uninstall(): void {
    if (!this.installed) return;
    this.planner.uninstall();
    this.dispatcher.uninstall();
    this.installed = false;
  }

  /** Access the shared ActionRegistry to register goals/actions. */
  getRegistry(): ActionRegistry {
    return this.registry;
  }

  /** Access the L0 planner for direct evaluation (testing/debugging). */
  getPlanner(): PlannerPluginL0 {
    return this.planner;
  }

  /** Access the dispatcher for introspection. */
  getDispatcher(): ActionDispatcherPlugin {
    return this.dispatcher;
  }

  /** Returns true if both plugins are installed. */
  isInstalled(): boolean {
    return this.installed;
  }
}

/**
 * CeremonyStateExtension — maintains ceremony state in WorldState.extensions.ceremonies.
 *
 * Subscribes to ceremony.*.completed events and updates the in-memory ceremonies
 * state, then publishes a world.state.snapshot update to the EventBus.
 *
 * Consumers can read WorldState.extensions.ceremonies to get:
 *   - registered ceremonies
 *   - execution history (most recent first, capped at 100)
 *   - current status per ceremony
 *   - last execution result per ceremony
 */

import type { EventBus, BusMessage } from "../../../lib/types.ts";
import type { Ceremony, CeremonyOutcome, CeremoniesState } from "../../plugins/CeremonyPlugin.types.ts";

const HISTORY_CAP = 100;

export class CeremonyStateExtension {
  private bus: EventBus | null = null;
  private subscriptionIds: string[] = [];

  private state: CeremoniesState = {
    ceremonies: {},
    history: [],
    status: {},
    lastRun: {},
    updatedAt: Date.now(),
  };

  /** Register a ceremony in the state. */
  registerCeremony(ceremony: Ceremony): void {
    this.state.ceremonies[ceremony.id] = ceremony;
    if (!this.state.status[ceremony.id]) {
      this.state.status[ceremony.id] = "idle";
    }
    this.state.updatedAt = Date.now();
  }

  /** Unregister a ceremony from the state. */
  unregisterCeremony(ceremonyId: string): void {
    delete this.state.ceremonies[ceremonyId];
    delete this.state.status[ceremonyId];
    this.state.updatedAt = Date.now();
  }

  /** Mark a ceremony as running. */
  markRunning(ceremonyId: string): void {
    this.state.status[ceremonyId] = "running";
    this.state.updatedAt = Date.now();
    this._publishSnapshot();
  }

  /** Install onto the EventBus to receive completed events. */
  install(bus: EventBus): void {
    this.bus = bus;

    // Subscribe to all ceremony completed events
    const subId = bus.subscribe("ceremony.#", "ceremony-state-extension", (msg: BusMessage) => {
      const topic = msg.topic;
      // Only handle .completed topics
      if (!topic.endsWith(".completed")) return;

      const payload = msg.payload as { type?: string; outcome?: CeremonyOutcome };
      if (payload?.type === "ceremony.completed" && payload.outcome) {
        this._onCeremonyCompleted(payload.outcome);
      }
    });
    this.subscriptionIds.push(subId);
  }

  /** Uninstall from the EventBus. */
  uninstall(): void {
    if (this.bus) {
      for (const id of this.subscriptionIds) {
        this.bus.unsubscribe(id);
      }
    }
    this.subscriptionIds = [];
    this.bus = null;
  }

  /** Get a snapshot of the current ceremonies state. */
  getState(): CeremoniesState {
    return { ...this.state };
  }

  private _onCeremonyCompleted(outcome: CeremonyOutcome): void {
    // Update status
    this.state.status[outcome.ceremonyId] =
      outcome.status === "success" ? "idle" : "failed";

    // Update last run
    this.state.lastRun[outcome.ceremonyId] = outcome;

    // Prepend to history, cap at HISTORY_CAP
    this.state.history.unshift(outcome);
    if (this.state.history.length > HISTORY_CAP) {
      this.state.history.length = HISTORY_CAP;
    }

    this.state.updatedAt = Date.now();
    this._publishSnapshot();
  }

  private _publishSnapshot(): void {
    if (!this.bus) return;

    const topic = "world.state.snapshot";
    this.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic,
      timestamp: Date.now(),
      payload: {
        domain: "extensions.ceremonies",
        data: this.getState(),
      },
    });
  }
}

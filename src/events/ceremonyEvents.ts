/**
 * Ceremony event payload types for the EventBus.
 *
 * Topic patterns:
 *   ceremony.{id}.execute   — fired when cron triggers a ceremony run
 *   ceremony.{id}.completed — fired after ceremony execution completes
 */

import type { CeremonyRunContext, CeremonyOutcome } from "../plugins/CeremonyPlugin.types.ts";

export interface CeremonyExecutePayload {
  type: "ceremony.execute";
  context: CeremonyRunContext;
  skill: string;
  ceremonyName: string;
}

export interface CeremonyCompletedPayload {
  type: "ceremony.completed";
  outcome: CeremonyOutcome;
}

/** Returns the execute topic for a given ceremony ID */
export function ceremonyExecuteTopic(ceremonyId: string): string {
  return `ceremony.${ceremonyId}.execute`;
}

/** Returns the completed topic for a given ceremony ID */
export function ceremonyCompletedTopic(ceremonyId: string): string {
  return `ceremony.${ceremonyId}.completed`;
}

/** Pattern that matches all ceremony execute events */
export const CEREMONY_EXECUTE_PATTERN = "ceremony.#";

/** Pattern that matches all ceremony completed events */
export const CEREMONY_COMPLETED_PATTERN = "ceremony.#";

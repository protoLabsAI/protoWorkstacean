/**
 * TOPICS — single barrel re-export of all bus topic constants.
 *
 * All domain groups are also exported individually for consumers that prefer
 * a scoped import (e.g. `import { WORLD_TOPICS } from "./topics.ts"`).
 *
 * Convention: world.action.* for planner-related events.
 */

export {
  MESSAGE_TOPICS,
  ACTION_TOPICS,
  SECURITY_TOPICS,
  FLOW_TOPICS,
  WORLD_TOPICS,
} from "./all-topics.ts";

import {
  MESSAGE_TOPICS,
  ACTION_TOPICS,
  SECURITY_TOPICS,
  FLOW_TOPICS,
  WORLD_TOPICS,
} from "./all-topics.ts";

export const TOPICS = {
  ...MESSAGE_TOPICS,
  ...ACTION_TOPICS,
  ...SECURITY_TOPICS,
  ...FLOW_TOPICS,
  ...WORLD_TOPICS,
} as const;

export type TopicValue = (typeof TOPICS)[keyof typeof TOPICS];

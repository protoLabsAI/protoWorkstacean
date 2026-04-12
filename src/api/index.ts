/**
 * API route registry — collects routes from all modules.
 *
 * To add new endpoints: create a new module in src/api/, export createRoutes(),
 * and import it here. No changes to src/index.ts needed.
 */

import type { Route, ApiContext } from "./types.ts";

import { createRoutes as worldStateRoutes } from "./world-state.ts";
import { createRoutes as githubRoutes } from "./github.ts";
import { createRoutes as incidentRoutes } from "./incidents.ts";
import { createRoutes as operationRoutes } from "./operations.ts";
import { createRoutes as planeRoutes } from "./plane.ts";
import { createRoutes as avaToolRoutes } from "./ava-tools.ts";
import { createRoutes as boardRoutes } from "./board.ts";

export { matchPath } from "./types.ts";
export type { Route, ApiContext } from "./types.ts";

export function createAllRoutes(ctx: ApiContext): Route[] {
  return [
    ...operationRoutes(ctx),
    ...worldStateRoutes(ctx),
    ...githubRoutes(ctx),
    ...incidentRoutes(ctx),
    ...planeRoutes(ctx),
    ...avaToolRoutes(ctx),
    ...boardRoutes(ctx),
  ];
}

/**
 * API route registry — collects routes from all modules.
 *
 * To add new endpoints: create a new module in src/api/, export createRoutes(),
 * and import it here. No changes to src/index.ts needed.
 */

import type { Route, ApiContext } from "./types.ts";

import { createRoutes as githubRoutes } from "./github.ts";
import { createRoutes as incidentRoutes } from "./incidents.ts";
import { createRoutes as operationRoutes } from "./operations.ts";
import { createRoutes as avaToolRoutes } from "./ava-tools.ts";
import { createRoutes as boardRoutes } from "./board.ts";
import { createRoutes as mailboxRoutes } from "./mailbox.ts";
import { createRoutes as discordRoutes } from "./discord.ts";
import { createRoutes as a2aCallbackRoutes } from "./a2a-callback.ts";
import { createRoutes as a2aServerRoutes } from "./a2a-server.ts";
import { createRoutes as agentCardRoutes } from "./agent-card.ts";
import { createRoutes as observabilityRoutes } from "./observability.ts";
import { createRoutes as operatorRoutes } from "./operator.ts";
import { createRoutes as openaiCompatRoutes } from "./openai-compat.ts";
import { createRoutes as googleRoutes } from "./google.ts";
import { createRoutes as linearRoutes } from "./linear.ts";
import { createRoutes as linearOAuthRoutes } from "./linear-oauth.ts";
import { createRoutes as busTopologyRoutes } from "./bus-topology.ts";
import { createRoutes as prInspectorRoutes } from "./pr-inspector.ts";
import { createRoutes as clawpatchRoutes } from "./clawpatch.ts";
import { createRoutes as agentsRuntimeRoutes } from "./agents-runtime.ts";
import { createRoutes as busHistoryRoutes } from "./bus-history.ts";
import { createRoutes as humanInputRoutes } from "./human-input.ts";

export { matchPath } from "./types.ts";
export type { Route, ApiContext } from "./types.ts";

export function createAllRoutes(ctx: ApiContext): Route[] {
  return [
    ...operationRoutes(ctx),
    ...githubRoutes(ctx),
    ...incidentRoutes(ctx),
    ...avaToolRoutes(ctx),
    ...boardRoutes(ctx),
    ...(ctx.mailbox ? mailboxRoutes(ctx.mailbox, ctx) : []),
    ...discordRoutes(ctx),
    ...(ctx.taskTracker ? a2aCallbackRoutes(ctx.taskTracker, ctx) : []),
    ...agentCardRoutes(ctx),
    ...a2aServerRoutes(ctx),
    ...observabilityRoutes(ctx),
    ...operatorRoutes(ctx),
    ...openaiCompatRoutes(ctx),
    ...googleRoutes(ctx),
    ...linearRoutes(ctx),
    ...linearOAuthRoutes(ctx),
    ...busTopologyRoutes(ctx),
    ...prInspectorRoutes(ctx),
    ...clawpatchRoutes(ctx),
    ...agentsRuntimeRoutes(ctx),
    ...busHistoryRoutes(ctx),
    ...humanInputRoutes(ctx),
  ];
}

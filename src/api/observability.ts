/**
 * Observability routes — exposes per-(agent, skill) cost + confidence summaries
 * captured by the cost-v1 and confidence-v1 extension interceptors.
 *
 * Primary consumer: the tuning agent, which reads these over HTTP to identify
 * outlier skills (low success rate, calibration inversions, expensive skills)
 * and proposes constraint changes through ConfigChangeHITL.
 */

import type { Route, ApiContext } from "./types.ts";
import { defaultCostStore } from "../executor/extensions/cost.ts";
import { defaultConfidenceStore } from "../executor/extensions/confidence.ts";

export function createRoutes(ctx: ApiContext): Route[] {
  function requireAuth(req: Request): Response | null {
    if (!ctx.apiKey) return null;
    const headerKey = req.headers.get("X-API-Key");
    const bearer = req.headers.get("Authorization");
    const apiKey = headerKey ?? (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null);
    if (apiKey === ctx.apiKey) return null;
    if (ctx.agentKeys && ctx.agentKeys.resolve(apiKey)) return null;
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  /**
   * GET /api/cost-summaries?agent=&skill=&minSamples=
   *
   * Returns an array of CostSummary records. Filters:
   *   - agent: only summaries for this agent name
   *   - skill: only summaries for this skill name
   *   - minSamples: only summaries with at least N samples (gates statistical noise)
   */
  function handleCostSummaries(req: Request): Response {
    const authErr = requireAuth(req);
    if (authErr) return authErr;

    const url = new URL(req.url);
    const agent = url.searchParams.get("agent");
    const skill = url.searchParams.get("skill");
    const minSamples = parseInt(url.searchParams.get("minSamples") ?? "0", 10);

    let summaries = defaultCostStore.allSummaries();
    if (agent) summaries = summaries.filter(s => s.agentName === agent);
    if (skill) summaries = summaries.filter(s => s.skill === skill);
    if (minSamples > 0) summaries = summaries.filter(s => s.sampleCount >= minSamples);

    return Response.json({ success: true, data: summaries });
  }

  /**
   * GET /api/confidence-summaries?agent=&skill=
   *
   * Returns an array of ConfidenceSummary records with calibration metrics
   * (avgConfidence, avgConfidenceOnSuccess/Failure, highConfFailures count).
   */
  function handleConfidenceSummaries(req: Request): Response {
    const authErr = requireAuth(req);
    if (authErr) return authErr;

    const url = new URL(req.url);
    const agent = url.searchParams.get("agent");
    const skill = url.searchParams.get("skill");

    let summaries = defaultConfidenceStore.allSummaries();
    if (agent) summaries = summaries.filter(s => s.agentName === agent);
    if (skill) summaries = summaries.filter(s => s.skill === skill);

    return Response.json({ success: true, data: summaries });
  }

  return [
    { method: "GET", path: "/api/cost-summaries",       handler: req => handleCostSummaries(req) },
    { method: "GET", path: "/api/confidence-summaries", handler: req => handleConfidenceSummaries(req) },
  ];
}

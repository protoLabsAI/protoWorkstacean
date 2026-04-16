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
import type { ConfigChangeRequest, ConfigChangeEvidence } from "../../lib/types.ts";
import { recordPendingContent } from "../../lib/plugins/config-change-hitl.ts";
import { join } from "node:path";

/** Minimum samples required for a data-driven agent-YAML proposal to be accepted. */
const MIN_SAMPLES_FOR_AGENT_PROPOSAL = 50;
/** Proposals expire if the operator hasn't decided within this window. */
const PROPOSAL_TTL_MS = 48 * 60 * 60_000;

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

  /**
   * POST /api/config-change/propose
   *
   * Agent-facing endpoint for submitting a ConfigChangeRequest through the
   * HITL approval gate. Validates evidence, registers pending content for
   * the applier, publishes `config.change.request.{correlationId}`.
   *
   * Body: { target, title, summary, yamlDiff, newContent?, evidence? }
   *   - target: "goals.yaml" | "actions.yaml" | { type: "agent", agentName }
   *   - evidence required when target is an agent; sampleCount >= 50
   *   - newContent required for auto-apply on approve (applier writes it)
   *
   * Response: { success, data: { correlationId, expiresAt } }
   */
  async function handleProposeConfigChange(req: Request): Promise<Response> {
    const authErr = requireAuth(req);
    if (authErr) return authErr;

    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

    const target = body.target as ConfigChangeRequest["configFile"] | undefined;
    const title = body.title as string | undefined;
    const summary = body.summary as string | undefined;
    const yamlDiff = body.yamlDiff as string | undefined;
    const newContent = body.newContent as string | undefined;
    const evidence = body.evidence as ConfigChangeEvidence | undefined;

    if (!target || !title || !summary || !yamlDiff) {
      return Response.json(
        { success: false, error: "target, title, summary, yamlDiff are required" },
        { status: 400 },
      );
    }

    const isAgentTarget = typeof target === "object" && (target as { type?: string }).type === "agent";
    if (isAgentTarget) {
      const agentName = (target as { agentName?: string }).agentName;
      if (!agentName || !/^[\w\-]+$/.test(agentName)) {
        return Response.json({ success: false, error: "Invalid agentName" }, { status: 400 });
      }
      if (agentName === "tuner") {
        return Response.json(
          { success: false, error: "Tuner cannot propose changes to its own YAML (self-modification loop guard)" },
          { status: 403 },
        );
      }
      if (!evidence) {
        return Response.json({ success: false, error: "Agent-YAML proposals require evidence block" }, { status: 400 });
      }
      if (evidence.sampleCount < MIN_SAMPLES_FOR_AGENT_PROPOSAL) {
        return Response.json(
          { success: false, error: `Agent-YAML proposals require sampleCount >= ${MIN_SAMPLES_FOR_AGENT_PROPOSAL} (got ${evidence.sampleCount})` },
          { status: 400 },
        );
      }
      if (!newContent) {
        return Response.json({ success: false, error: "Agent-YAML proposals require newContent for auto-apply" }, { status: 400 });
      }
    }

    const correlationId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS).toISOString();
    const replyTopic = `config.change.response.${correlationId}`;

    let targetPath: string;
    if (target === "goals.yaml" || target === "actions.yaml") {
      targetPath = join(ctx.workspaceDir, target);
    } else if (isAgentTarget) {
      targetPath = join(ctx.workspaceDir, "agents", `${(target as { agentName: string }).agentName}.yaml`);
    } else {
      return Response.json({ success: false, error: "Invalid target" }, { status: 400 });
    }

    if (newContent) {
      recordPendingContent(correlationId, targetPath, newContent);
    }

    const proposal: ConfigChangeRequest = {
      type: "config_change_request",
      correlationId,
      configFile: target,
      title,
      summary,
      yamlDiff,
      ...(evidence ? { evidence } : {}),
      options: ["approve", "reject"],
      expiresAt,
      replyTopic,
      sourceMeta: { interface: "discord" },
    };

    ctx.bus.publish(`config.change.request.${correlationId}`, {
      id: crypto.randomUUID(),
      correlationId,
      topic: `config.change.request.${correlationId}`,
      timestamp: Date.now(),
      payload: proposal,
    });

    return Response.json({ success: true, data: { correlationId, expiresAt } });
  }

  return [
    { method: "GET",  path: "/api/cost-summaries",        handler: req => handleCostSummaries(req) },
    { method: "GET",  path: "/api/confidence-summaries",  handler: req => handleConfidenceSummaries(req) },
    { method: "POST", path: "/api/config-change/propose", handler: req => handleProposeConfigChange(req) },
  ];
}

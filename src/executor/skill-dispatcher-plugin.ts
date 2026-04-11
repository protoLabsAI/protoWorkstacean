/**
 * SkillDispatcherPlugin — sole subscriber to agent.skill.request.
 *
 * Receives skill requests from any source (RouterPlugin, ActionDispatcherPlugin,
 * HTTP API, etc.), resolves the appropriate executor via ExecutorRegistry, and
 * delegates execution. Publishes the result to the reply topic.
 *
 * This is the single dispatch point for all agent skill execution.
 * AgentRuntimePlugin and SkillBrokerPlugin are registrars only — they populate
 * the ExecutorRegistry during install() but do not subscribe to agent.skill.request.
 *
 * Inbound:  agent.skill.request
 * Outbound: {replyTopic}  (from msg.reply.topic or agent.skill.response.{correlationId})
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { ExecutorRegistry } from "./executor-registry.ts";
import type { SkillRequest } from "./types.ts";
import type { AgentSkillRequestPayload, FlowItemPayload } from "../event-bus/payloads.ts";
import { GraphitiClient } from "../../lib/memory/graphiti-client.ts";
import { IdentityRegistry } from "../../lib/identity/identity-registry.ts";

/**
 * Classify a skill name into a flow item type for distribution tracking.
 * Keeps flow.distribution_balanced honest: bug_triage is defect work, not
 * feature work. Previously everything was hard-coded to "feature" which
 * drove the distribution to 100% features and permanently violated the
 * goal regardless of reality.
 */
function classifyFlowType(skill: string): "feature" | "defect" | "risk" | "debt" {
  if (skill.includes("bug") || skill.includes("triage_issue") || skill.includes("fix")) return "defect";
  if (skill.includes("security") || skill.includes("incident")) return "risk";
  if (skill.includes("review") || skill.includes("refactor") || skill.includes("cleanup")) return "debt";
  return "feature";
}

export class SkillDispatcherPlugin implements Plugin {
  readonly name = "skill-dispatcher";
  readonly description = "Sole agent.skill.request subscriber — resolves executor and dispatches";
  readonly capabilities = ["skill-dispatch"];

  private bus?: EventBus;
  private readonly subscriptionIds: string[] = [];
  private readonly graphiti: GraphitiClient;
  private readonly identityRegistry: IdentityRegistry;

  constructor(
    private readonly registry: ExecutorRegistry,
    workspaceDir: string,
    /** Injectable for testing — defaults to a real GraphitiClient. */
    graphiti?: GraphitiClient,
  ) {
    this.graphiti = graphiti ?? new GraphitiClient();
    this.identityRegistry = new IdentityRegistry(workspaceDir);
  }

  install(bus: EventBus): void {
    this.bus = bus;

    const subId = bus.subscribe("agent.skill.request", this.name, (msg: BusMessage) => {
      void this._dispatch(msg);
    });
    this.subscriptionIds.push(subId);

    console.log("[skill-dispatcher] Installed");
  }

  uninstall(): void {
    if (this.bus) {
      for (const id of this.subscriptionIds) {
        this.bus.unsubscribe(id);
      }
    }
    this.subscriptionIds.length = 0;
    this.bus = undefined;
    this.identityRegistry.unwatch();
  }

  private async _dispatch(msg: BusMessage): Promise<void> {
    const payload = (msg.payload ?? {}) as AgentSkillRequestPayload;

    const skill = payload.skill
      ?? (typeof payload.meta?.skillHint === "string" ? payload.meta.skillHint : undefined)
      ?? "";

    let targets: string[] = [];
    if (Array.isArray(payload.targets)) {
      targets = payload.targets;
    } else if (typeof payload.meta?.agentId === "string") {
      targets = [payload.meta.agentId];
    }

    const correlationId = msg.correlationId;
    const parentId = msg.id; // this message is the parent span
    const replyTopic = msg.reply?.topic ?? `agent.skill.response.${correlationId}`;

    if (!skill) {
      console.warn("[skill-dispatcher] Received skill request with no skill — dropping");
      this._publishResponse(replyTopic, correlationId, undefined, "No skill specified");
      return;
    }

    const executor = this.registry.resolve(skill, targets);

    if (!executor) {
      const searched = targets.length > 0
        ? `targets [${targets.join(", ")}] or skill "${skill}"`
        : `skill "${skill}"`;
      console.warn(`[skill-dispatcher] No executor found for ${searched} — dropping`);
      this._publishResponse(replyTopic, correlationId, undefined, `No executor registered for ${searched}`);
      return;
    }

    console.log(
      `[skill-dispatcher] Dispatching "${skill}" via ${executor.type}` +
      (targets.length > 0 ? ` (targets: ${targets.join(", ")})` : ""),
    );

    // ── Memory enrichment ──────────────────────────────────────────────────────
    // Graphiti group id selection (alphanumeric/dash/underscore only — colons
    // crash graphiti's ingestion worker silently):
    //   (a) human-originated: user_{canonicalId} via identityRegistry
    //   (b) bot-initiated with meta.systemActor (pr-remediator / sweep /
    //       ceremony / cron): system_{actor} — gives the autonomous loop
    //       its own persistent memory of what it did, grouped by the
    //       subsystem that triggered it
    //   (c) fallthrough: no group — no write, no read
    //
    // For (a) we also compute an agent-scoped group so each agent
    // accumulates its own relationship memory with the user on top of
    // the shared cross-agent baseline.
    const sourceUserId: string | undefined =
      typeof msg.source?.userId === "string" ? msg.source.userId : undefined;
    const sourcePlatform: string | undefined =
      typeof msg.source?.interface === "string" ? msg.source.interface : undefined;
    const sourceChannelId: string | undefined =
      typeof msg.source?.channelId === "string" ? msg.source.channelId : undefined;
    const systemActor: string | undefined =
      typeof payload.meta?.systemActor === "string" ? payload.meta.systemActor : undefined;

    let rawContent = typeof payload.content === "string" ? payload.content : undefined;
    const originalContent = rawContent; // preserved for episode storage — never includes context prefix
    let groupId: string | undefined;
    let agentGroupId: string | undefined;

    if (sourceUserId && sourcePlatform && sourcePlatform !== "cron") {
      groupId = this.identityRegistry.groupId(sourcePlatform, sourceUserId);
      const agentName = targets[0];
      // agent_{agent}__{user_...} — double underscore separates the two
      // identity segments unambiguously. Single-underscore would collide
      // with the user_{platform}_{id} fallback.
      if (agentName) agentGroupId = `agent_${agentName}__${groupId}`;
    } else if (systemActor) {
      // Bot-initiated dispatch — memory goes to a stable system-actor group
      // so the autonomous loop builds its own episodic history. No
      // agent-scoped split: it's already one subsystem writing, not a
      // human talking to a specific agent.
      groupId = `system_${systemActor}`;
    }

    if (groupId && rawContent) {
      const [sharedCtx, agentCtx] = await Promise.all([
        this.graphiti.getContextBlock(groupId, rawContent).catch(() => ""),
        agentGroupId ? this.graphiti.getContextBlock(agentGroupId, rawContent).catch(() => "") : Promise.resolve(""),
      ]);
      const combined = [sharedCtx, agentCtx].filter(Boolean).join("");
      if (combined) rawContent = `${combined}${rawContent}`;
    }
    // ── End memory enrichment ─────────────────────────────────────────────────

    const req: SkillRequest = {
      skill,
      content: rawContent,
      prompt: typeof payload.prompt === "string" ? payload.prompt : undefined,
      correlationId,
      parentId,
      replyTopic,
      payload,
    };

    const flowItemId = `skill-${correlationId}`;
    const dispatchedAt = Date.now();
    this._publishFlowEvent("flow.item.created", {
      id: flowItemId,
      type: classifyFlowType(skill),
      status: "active",
      stage: "dispatched",
      createdAt: dispatchedAt,
      startedAt: dispatchedAt,
      meta: { skill, executorType: executor.type },
    });

    try {
      const result = await executor.execute(req);

      if (result.isError) {
        console.error(
          `[skill-dispatcher] Executor "${executor.type}" error for skill "${skill}": ${(result.text ?? "").slice(0, 500)}`,
        );
        this._publishFlowEvent("flow.item.updated", {
          id: flowItemId,
          status: "blocked",
          stage: "error",
          meta: { skill, error: result.text },
        });
      } else {
        // Log a preview of the response so we can see what the executor actually
        // returned — critical for debugging A2A/agent behaviour when the skill
        // completes but produces no board side-effects.
        const preview = (result.text ?? "").replace(/\s+/g, " ").slice(0, 300);
        console.log(
          `[skill-dispatcher] Skill "${skill}" completed via ${executor.type} — ${(result.text ?? "").length} chars: ${preview}${(result.text ?? "").length > 300 ? "…" : ""}`,
        );
        if (result.data?.stopReason === "max_turns") {
          console.warn("[skill-dispatcher] Agent hit maxTurns limit");
        }
        this._publishFlowEvent("flow.item.completed", {
          id: flowItemId,
          status: "complete",
          stage: "done",
          completedAt: Date.now(),
          meta: {
            skill,
            executorType: executor.type,
            durationMs: Date.now() - dispatchedAt,
            inputTokens: result.data?.usage?.input_tokens,
            outputTokens: result.data?.usage?.output_tokens,
            numTurns: result.data?.numTurns,
            stopReason: result.data?.stopReason,
          },
        });
      }

      // Store completed turn in Graphiti (fire-and-forget, non-blocking).
      //
      // User-originated: written to the shared user group AND the
      //   agent-scoped group so each agent accumulates its own relationship
      //   history with the user on top of the cross-agent baseline.
      //
      // System-originated (bot-initiated, meta.systemActor set): written
      //   only to the single system_{actor} group. No agent split —
      //   systemActor IS the actor, no user involved.
      if (!result.isError && result.text && groupId && originalContent) {
        const identity = sourceUserId && sourcePlatform
          ? this.identityRegistry.resolve(sourcePlatform, sourceUserId)
          : null;
        const episodeBase = {
          userMessage: originalContent,
          agentMessage: result.text,
          userRole: identity?.displayName ?? sourceUserId ?? systemActor,
          agentName: targets[0],
          channelId: sourceChannelId,
          platform: sourcePlatform ?? (systemActor ? "system" : undefined),
        };
        this.graphiti.addEpisode({ groupId, ...episodeBase })
          .catch(err => console.debug("[skill-dispatcher] Graphiti addEpisode (shared) error:", err));
        if (agentGroupId) {
          this.graphiti.addEpisode({ groupId: agentGroupId, ...episodeBase })
            .catch(err => console.debug("[skill-dispatcher] Graphiti addEpisode (agent) error:", err));
        }
      }

      this._publishResponse(
        replyTopic,
        correlationId,
        result.isError ? undefined : result.text,
        result.isError ? result.text || "Executor error" : undefined,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[skill-dispatcher] Unhandled error dispatching "${skill}": ${errorMsg}`);
      this._publishFlowEvent("flow.item.updated", {
        id: flowItemId,
        status: "blocked",
        stage: "error",
        meta: { skill, error: errorMsg },
      });
      this._publishResponse(replyTopic, correlationId, undefined, errorMsg);
    }
  }

  private _publishFlowEvent(topic: string, item: FlowItemPayload): void {
    if (!this.bus) return;
    this.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: item.id,
      topic,
      timestamp: Date.now(),
      payload: item,
    });
  }

  private _publishResponse(
    replyTopic: string,
    correlationId: string,
    result: string | undefined,
    error: string | undefined,
  ): void {
    if (!this.bus) return;
    this.bus.publish(replyTopic, {
      id: crypto.randomUUID(),
      correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: { content: result, error, correlationId },
    });
  }
}

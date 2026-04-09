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
import { GraphitiClient } from "../../lib/memory/graphiti-client.ts";
import { IdentityRegistry } from "../../lib/identity/identity-registry.ts";

export class SkillDispatcherPlugin implements Plugin {
  readonly name = "skill-dispatcher";
  readonly description = "Sole agent.skill.request subscriber — resolves executor and dispatches";
  readonly capabilities = ["skill-dispatch"];

  private bus?: EventBus;
  private readonly subscriptionIds: string[] = [];
  private readonly graphiti = new GraphitiClient();
  private readonly identityRegistry: IdentityRegistry;

  constructor(
    private readonly registry: ExecutorRegistry,
    workspaceDir: string,
  ) {
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
  }

  private async _dispatch(msg: BusMessage): Promise<void> {
    const payload = (msg.payload ?? {}) as Record<string, unknown>;

    const skill = (payload.skill as string | undefined)
      ?? (payload.meta as Record<string, unknown> | undefined)?.skillHint as string | undefined
      ?? "";

    const targets: string[] = Array.isArray(payload.targets)
      ? (payload.targets as string[])
      : typeof (payload.meta as Record<string, unknown> | undefined)?.agentId === "string"
        ? [(payload.meta as Record<string, unknown>).agentId as string]
        : [];

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
    // Prepend user context from Graphiti for human-originating messages.
    // Cron/system events (no userId) are skipped.
    const sourceUserId = (msg.source as Record<string, unknown> | undefined)?.userId as string | undefined;
    const sourcePlatform = (msg.source as Record<string, unknown> | undefined)?.interface as string | undefined;
    const sourceChannelId = (msg.source as Record<string, unknown> | undefined)?.channelId as string | undefined;

    let rawContent = typeof payload.content === "string" ? payload.content : undefined;
    let groupId: string | undefined;

    if (sourceUserId && sourcePlatform && sourcePlatform !== "cron") {
      groupId = this.identityRegistry.groupId(sourcePlatform, sourceUserId);
      if (rawContent) {
        const memoryContext = await this.graphiti.getContextBlock(groupId, rawContent).catch(() => "");
        if (memoryContext) rawContent = `${memoryContext}\n${rawContent}`;
      }
    }
    // ── End memory enrichment ─────────────────────────────────────────────────

    const req: SkillRequest = {
      skill,
      content: rawContent,
      prompt: typeof payload.prompt === "string" ? payload.prompt : undefined,
      correlationId,
      parentId,
      replyTopic,
      payload: payload as Record<string, unknown>,
    };

    const flowItemId = `skill-${correlationId}`;
    const dispatchedAt = Date.now();
    this._publishFlowEvent("flow.item.created", {
      id: flowItemId,
      type: "feature",
      status: "active",
      stage: "dispatched",
      createdAt: dispatchedAt,
      startedAt: dispatchedAt,
      meta: { skill, executorType: executor.type },
    });

    try {
      const result = await executor.execute(req);

      if (result.isError) {
        console.error(`[skill-dispatcher] Executor "${executor.type}" error for skill "${skill}"`);
        this._publishFlowEvent("flow.item.updated", {
          id: flowItemId,
          status: "blocked",
          stage: "error",
          meta: { skill, error: result.text },
        });
      } else {
        console.log(`[skill-dispatcher] Skill "${skill}" completed via ${executor.type}`);
        this._publishFlowEvent("flow.item.completed", {
          id: flowItemId,
          status: "complete",
          stage: "done",
          completedAt: Date.now(),
          meta: { skill, executorType: executor.type, durationMs: Date.now() - dispatchedAt },
        });
      }

      // Store completed turn in Graphiti (fire-and-forget, non-blocking)
      if (!result.isError && result.text && groupId && rawContent) {
        const identity = sourceUserId && sourcePlatform
          ? this.identityRegistry.resolve(sourcePlatform, sourceUserId)
          : null;
        this.graphiti.addEpisode({
          groupId,
          userMessage: rawContent,
          agentMessage: result.text,
          userRole: identity?.displayName ?? sourceUserId,
          agentName: targets[0],
          channelId: sourceChannelId,
          platform: sourcePlatform,
        }).catch(err => console.debug("[skill-dispatcher] Graphiti addEpisode error:", err));
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

  private _publishFlowEvent(topic: string, item: Record<string, unknown>): void {
    if (!this.bus) return;
    this.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: item.id as string,
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
      payload: { result, error, correlationId },
    });
  }
}

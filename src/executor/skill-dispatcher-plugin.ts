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
import type { LoggerPlugin, ConversationTurn } from "../../lib/plugins/logger.ts";
import { ContextMailbox } from "../../lib/dm/context-mailbox.ts";
import type { TaskTracker } from "./task-tracker.ts";
import type { A2AExecutor } from "./executors/a2a-executor.ts";

const WORKING_STATES = new Set(["submitted", "working"]);

/**
 * Assemble a structured context envelope for the agent prompt.
 *
 * Pure function — no side effects, suitable for unit testing.
 *
 * Sections emitted (in order, only when non-empty):
 *   <recalled_memory>  — Graphiti facts retrieved for this user
 *   <recent_conversation> — last N turns from LoggerPlugin
 *   <current_message>  — the user's actual input (always emitted)
 *
 * When there is no history (no memory, no turns), only <current_message>
 * is emitted — no empty XML tags.
 */
export function assembleContext(
  recalledMemory: string | undefined,
  recentTurns: ConversationTurn[],
  currentMessage: string,
): string {
  const parts: string[] = [];

  if (recalledMemory) {
    parts.push(
      `<recalled_memory>\n` +
      `The following facts were retrieved from your memory about this user. ` +
      `Use them as background context if relevant — do NOT repeat them back ` +
      `to the user or reference them unless the user's message specifically ` +
      `asks about something they relate to. Focus your response on what the ` +
      `user is actually saying below.\n\n` +
      `${recalledMemory}\n` +
      `</recalled_memory>`,
    );
  }

  if (recentTurns.length > 0) {
    const turnLines = recentTurns.map(turn => {
      const ts = new Date(turn.createdAt).toISOString();
      const channelSuffix = turn.channel ? ` [${turn.channel}]` : "";
      const label = turn.role === "user" ? "User" : "Assistant";
      return `[${ts}${channelSuffix}] ${label}: ${turn.content}`;
    });
    parts.push(`<recent_conversation>\n${turnLines.join("\n")}\n</recent_conversation>`);
  }

  parts.push(`<current_message>\n${currentMessage}\n</current_message>`);

  return parts.join("\n\n");
}

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
  private readonly loggerPlugin: LoggerPlugin | undefined;
  private readonly mailbox: ContextMailbox | undefined;
  private readonly taskTracker: TaskTracker | undefined;

  /**
   * In-flight execution tracking — set at the TOP of _dispatch() (before any
   * await) so isActive() is accurate even during the async Graphiti enrichment
   * window. Without this, a DM debounce timer firing during enrichment would
   * see isActive() === false and double-dispatch.
   */
  private readonly activeExecutions = new Map<string, { startedAt: number; skill: string }>();

  constructor(
    private readonly registry: ExecutorRegistry,
    workspaceDir: string,
    /** Injectable for testing — defaults to a real GraphitiClient. */
    graphiti?: GraphitiClient,
    /** Injectable for testing — provides recent conversation turns. */
    loggerPlugin?: LoggerPlugin,
    /** Optional mailbox for mid-execution DM queuing. */
    mailbox?: ContextMailbox,
    /** Optional tracker for long-running A2A tasks. */
    taskTracker?: TaskTracker,
  ) {
    this.graphiti = graphiti ?? new GraphitiClient();
    this.identityRegistry = new IdentityRegistry(workspaceDir);
    this.loggerPlugin = loggerPlugin;
    this.mailbox = mailbox;
    this.taskTracker = taskTracker;
  }

  /** Check if an execution is currently active for a given correlationId. */
  isActive(correlationId: string): boolean {
    return this.activeExecutions.has(correlationId);
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

    // Mark as active IMMEDIATELY — before any await. _dispatch() is called via
    // `void this._dispatch(msg)` (fire-and-forget from the sync bus handler).
    // The async Graphiti enrichment below yields to the event loop for 100-500ms.
    // Without this early set, a DM debounce timer firing during that window would
    // see isActive() === false and dispatch a competing execution.
    this.activeExecutions.set(correlationId, { startedAt: Date.now(), skill: skill || "unknown" });

    if (!skill) {
      this.activeExecutions.delete(correlationId);
      console.warn("[skill-dispatcher] Received skill request with no skill — dropping");
      this._publishResponse(replyTopic, correlationId, undefined, "No skill specified");
      return;
    }

    const executor = this.registry.resolve(skill, targets);

    if (!executor) {
      this.activeExecutions.delete(correlationId);
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
      const combined = [sharedCtx, agentCtx].filter(Boolean).join("\n");

      // Retrieve recent turns for human-originated messages only
      const recentTurns: ConversationTurn[] = (this.loggerPlugin && sourceUserId)
        ? this.loggerPlugin.getRecentTurnsForUser(
            sourceUserId,
            targets[0] ?? "",
            8,
            24 * 60 * 60 * 1000,
          )
        : [];

      rawContent = assembleContext(combined || undefined, recentTurns, rawContent);
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

      // Long-running A2A task — agent returned non-terminal state with a taskId.
      // Hand off to TaskTracker; dispatcher exits without publishing response.
      // Tracker will publish to replyTopic once the task reaches terminal state.
      const taskState = result.data?.taskState;
      const taskId = result.data?.taskId;
      if (
        this.taskTracker
        && !result.isError
        && taskState
        && typeof taskState === "string"
        && WORKING_STATES.has(taskState)
        && taskId
        && executor.type === "a2a"
      ) {
        const a2aExecutor = executor as A2AExecutor;
        const callbackToken = crypto.randomUUID();
        this.taskTracker.track({
          correlationId,
          taskId,
          agentName: targets[0] ?? "unknown",
          replyTopic,
          executor: a2aExecutor,
          parentId,
          callbackToken,
        });

        // Try to register a push-notification webhook so the agent can POST
        // completion back instead of us polling. Falls back to polling silently.
        const callbackBaseUrl = process.env.WORKSTACEAN_BASE_URL;
        if (callbackBaseUrl) {
          const callbackUrl = `${callbackBaseUrl.replace(/\/$/, "")}/api/a2a/callback/${encodeURIComponent(taskId)}`;
          void a2aExecutor.registerPushNotification(taskId, callbackUrl, callbackToken, correlationId, parentId)
            .then(ok => {
              if (ok) console.log(`[skill-dispatcher] Push-notification registered for ${taskId.slice(0, 8)}…`);
            })
            .catch(err => console.debug("[skill-dispatcher] push-notification register failed:", err));
        }

        this._publishFlowEvent("flow.item.updated", {
          id: flowItemId,
          status: "active",
          stage: "running",
          meta: { skill, taskId, taskState, trackedBy: "task-tracker" },
        });
        // Don't publish a response — tracker will do it. Still fall through to
        // finally block so activeExecutions gets cleaned up.
        return;
      }

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
    } finally {
      this.activeExecutions.delete(correlationId);
      this._drainMailbox(correlationId, skill, targets, msg.source, replyTopic);
    }
  }

  /**
   * Drain pending mailbox messages after execution completes.
   *
   * If the user sent additional DMs while the agent was working, they
   * accumulated in the ContextMailbox. This method drains them and publishes
   * a new agent.skill.request so the conversation continues with the same
   * agent/skill and full memory enrichment.
   */
  private _drainMailbox(
    correlationId: string,
    skill: string,
    targets: string[],
    source: BusMessage["source"],
    replyTopic: string,
  ): void {
    if (!this.bus || !this.mailbox?.has(correlationId)) return;

    const queued = this.mailbox.drain(correlationId);
    if (queued.length === 0) return;

    const formatted = ContextMailbox.format(queued);
    console.log(
      `[skill-dispatcher] Draining ${queued.length} queued message(s) for ${correlationId} — starting new turn`,
    );

    this.bus.publish("agent.skill.request", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "agent.skill.request",
      timestamp: Date.now(),
      payload: {
        skill,
        content: formatted,
        targets,
        isDM: true,
      },
      source,
      reply: { topic: replyTopic },
    });
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

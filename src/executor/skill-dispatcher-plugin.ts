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

import type { Plugin, EventBus, BusMessage, ConversationTurn, LoggerTurnQueryRequest, LoggerTurnQueryResponse } from "../../lib/types.ts";
import type { ExecutorRegistry } from "./executor-registry.ts";
import type { SkillRequest } from "./types.ts";
import type { AgentSkillRequestPayload, AutonomousOutcomePayload, FlowItemPayload } from "../event-bus/payloads.ts";
import { GraphitiClient } from "../../lib/memory/graphiti-client.ts";
import { IdentityRegistry } from "../../lib/identity/identity-registry.ts";
import { assembleContext } from "../../lib/conversation/context-assembler.ts";
import { ContextMailbox } from "../../lib/dm/context-mailbox.ts";
import type { TaskTracker } from "./task-tracker.ts";
import type { A2AExecutor } from "./executors/a2a-executor.ts";
import { SessionStore } from "../agent-runtime/session-context.ts";

const WORKING_STATES = new Set(["submitted", "working"]);

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
  private readonly mailbox: ContextMailbox | undefined;
  private readonly taskTracker: TaskTracker | undefined;
  private readonly sessionStore: SessionStore;

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
    /** Optional mailbox for mid-execution DM queuing. */
    mailbox?: ContextMailbox,
    /** Optional tracker for long-running A2A tasks. */
    taskTracker?: TaskTracker,
    /** Optional session store for SDK session continuation across turns. */
    sessionStore?: SessionStore,
  ) {
    this.graphiti = graphiti ?? new GraphitiClient();
    this.identityRegistry = new IdentityRegistry(workspaceDir);
    this.mailbox = mailbox;
    this.taskTracker = taskTracker;
    this.sessionStore = sessionStore ?? new SessionStore();
  }

  /** Check if an execution is currently active for a given correlationId. */
  isActive(correlationId: string): boolean {
    return this.activeExecutions.has(correlationId);
  }

  /**
   * Query LoggerPlugin for recent conversation turns via the bus.
   * Resolves with [] if LoggerPlugin is not installed (timeout) or on any error.
   */
  private _queryRecentTurns(userId: string, agentName: string): Promise<ConversationTurn[]> {
    if (!this.bus) return Promise.resolve([]);

    return new Promise<ConversationTurn[]>((resolve) => {
      const replyTopic = `logger.turn.query.response.${crypto.randomUUID()}`;
      let settled = false;

      const subId = this.bus!.subscribe(replyTopic, this.name, (msg: BusMessage) => {
        if (settled) return;
        settled = true;
        this.bus!.unsubscribe(subId);
        resolve((msg.payload as LoggerTurnQueryResponse).turns);
      });

      this.bus!.publish("logger.turn.query", {
        id: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        topic: "logger.turn.query",
        timestamp: Date.now(),
        payload: {
          type: "logger.turn.query",
          userId,
          agentName,
          limit: 8,
          maxAgeMs: 24 * 60 * 60 * 1000,
          replyTopic,
        } satisfies LoggerTurnQueryRequest,
      });

      // Fallback: LoggerPlugin responds synchronously, so if not installed
      // the timeout fires at next tick and we continue without turns.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          this.bus?.unsubscribe(subId);
          resolve([]);
        }
      }, 0);
    });
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
    // When GOAP publishes to agent.skill.request, it stamps actionId + goalId
    // on meta so the autonomous outcome can carry them back to the planner's
    // loop detector.
    const goapActionId: string | undefined =
      typeof payload.meta?.actionId === "string" ? payload.meta.actionId : undefined;
    const goapGoalId: string | undefined =
      typeof payload.meta?.goalId === "string" ? payload.meta.goalId
      : (typeof payload.goalId === "string" ? payload.goalId : undefined);
    // Name of the agent that issued this skill request (via chat_with_agent /
    // delegate_task). Carried forward to TaskTracker so input-required prompts
    // can route back to the dispatcher instead of straight to the operator.
    const dispatcherAgent: string | undefined =
      typeof payload.meta?.dispatcherAgent === "string" ? payload.meta.dispatcherAgent : undefined;

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

      // Retrieve recent turns for human-originated messages only via bus query
      const recentTurns: ConversationTurn[] = sourceUserId
        ? await this._queryRecentTurns(sourceUserId, targets[0] ?? "")
        : [];

      rawContent = assembleContext(combined || undefined, recentTurns, rawContent);
    }
    // ── End memory enrichment ─────────────────────────────────────────────────

    // Look up any existing SDK session for this correlationId+agent pair so the
    // executor can resume conversation context across multiple skill turns.
    const agentName = targets[0] ?? "";
    const existingSession = agentName
      ? this.sessionStore.get(correlationId, agentName)
      : undefined;

    const req: SkillRequest = {
      skill,
      content: rawContent,
      prompt: typeof payload.prompt === "string" ? payload.prompt : undefined,
      correlationId,
      parentId,
      replyTopic,
      payload,
      ...(existingSession ? { resume: existingSession.sessionId } : {}),
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
          skillName: skill,
          replyTopic,
          executor: a2aExecutor,
          parentId,
          callbackToken,
          sourceInterface: sourcePlatform,
          sourceChannelId: sourceChannelId,
          sourceUserId: sourceUserId,
          ...(dispatcherAgent ? { dispatcherAgent } : {}),
          onTerminal: (content, isError, taskState) => {
            this._publishAutonomousOutcome({
              correlationId,
              parentId,
              systemActor: systemActor ?? "user",
              skill,
              actionId: goapActionId,
              goalId: goapGoalId,
              success: !isError,
              taskState,
              text: content,
              durationMs: Date.now() - dispatchedAt,
            });

            const gh = payload.github as { title?: string; owner?: string; repo?: string; number?: number; url?: string } | undefined;
            if (skill === "bug_triage" && gh?.title && !isError && typeof payload.projectPath === "string") {
              void this._fileTriageOnBoard(gh as Required<Pick<typeof gh, "title">> & typeof gh, content, payload.projectPath as string);
            }
          },
        });

        // Register a push-notification webhook only when the agent advertises
        // capabilities.pushNotifications in its card. Without the gate we
        // burn a round-trip on every long-running task against every agent,
        // most of which reject. SkillBrokerPlugin refreshes the flag every
        // 10 min so capability changes land automatically.
        //
        // Callback URL routing:
        //   - Docker-internal agents (hostname like `http://quinn:7870`) use
        //     WORKSTACEAN_INTERNAL_BASE_URL (default http://workstacean:3000)
        //     which resolves inside the shared docker network.
        //   - External agents reached over Tailscale / public networks
        //     (hostname has a dot, e.g. `http://host.tailnet.ts.net:...`)
        //     use WORKSTACEAN_BASE_URL — the operator-configured public URL.
        const callbackBaseUrl = this._pickCallbackBaseUrl(a2aExecutor.url);
        if (callbackBaseUrl && a2aExecutor.pushNotifications) {
          const callbackUrl = `${callbackBaseUrl.replace(/\/$/, "")}/api/a2a/callback/${encodeURIComponent(taskId)}`;
          void a2aExecutor.registerPushNotification(taskId, callbackUrl, callbackToken, correlationId, parentId)
            .then(ok => {
              if (ok) console.log(`[skill-dispatcher] Push-notification registered for ${taskId.slice(0, 8)}…`);
            })
            .catch(err => console.debug("[skill-dispatcher] push-notification register failed:", err));
        } else if (callbackBaseUrl) {
          console.log(
            `[skill-dispatcher] ${a2aExecutor.name}: card.capabilities.pushNotifications=false — using polling for ${taskId.slice(0, 8)}…`,
          );
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
        this._publishAutonomousOutcome({
          correlationId,
          parentId,
          systemActor: systemActor ?? "user",
          skill,
          actionId: goapActionId,
          goalId: goapGoalId,
          success: false,
          taskState: result.data?.taskState ?? "failed",
          text: result.text,
          usage: result.data?.usage,
          durationMs: Date.now() - dispatchedAt,
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

        // Persist the SDK session ID so the next turn for this agent can resume it.
        if (result.data?.sessionId && agentName) {
          this.sessionStore.set(correlationId, agentName, result.data.sessionId);
        }
        const completedAt = Date.now();
        const durationMs = completedAt - dispatchedAt;
        this._publishFlowEvent("flow.item.completed", {
          id: flowItemId,
          status: "complete",
          stage: "done",
          completedAt,
          meta: {
            skill,
            executorType: executor.type,
            durationMs,
            inputTokens: result.data?.usage?.input_tokens,
            outputTokens: result.data?.usage?.output_tokens,
            numTurns: result.data?.numTurns,
            stopReason: result.data?.stopReason,
          },
        });
        this._publishAutonomousOutcome({
          correlationId,
          parentId,
          systemActor: systemActor ?? "user",
          skill,
          actionId: goapActionId,
          goalId: goapGoalId,
          success: true,
          taskState: result.data?.taskState ?? "completed",
          text: result.text,
          usage: result.data?.usage,
          durationMs,
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
          parentTurnId: correlationId,
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
      this._publishAutonomousOutcome({
        correlationId,
        parentId,
        systemActor: systemActor ?? "user",
        skill,
        actionId: goapActionId,
        goalId: goapGoalId,
        success: false,
        taskState: "failed",
        text: errorMsg,
        durationMs: Date.now() - dispatchedAt,
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

  private _publishAutonomousOutcome(opts: {
    correlationId: string;
    parentId: string | undefined;
    systemActor: string;
    skill: string;
    actionId?: string;
    goalId?: string;
    success: boolean;
    error?: string;
    taskState?: string;
    text?: string;
    usage?: AutonomousOutcomePayload["usage"];
    durationMs: number;
  }): void {
    if (!this.bus) return;
    const topic = `autonomous.outcome.${opts.systemActor}.${opts.skill}`;
    const payload: AutonomousOutcomePayload = {
      correlationId: opts.correlationId,
      parentId: opts.parentId,
      systemActor: opts.systemActor,
      skill: opts.skill,
      actionId: opts.actionId,
      goalId: opts.goalId,
      success: opts.success,
      error: opts.error,
      taskState: opts.taskState,
      textPreview: opts.text ? opts.text.slice(0, 500) : undefined,
      usage: opts.usage,
      durationMs: opts.durationMs,
    };
    this.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: opts.correlationId,
      topic,
      timestamp: Date.now(),
      payload,
    });
  }

  /**
   * Pick the callback base URL for push notifications based on whether the
   * target agent is docker-internal or external. Docker service names are
   * short hostnames (no dots); external hosts use FQDNs or IPs.
   *
   * Internal default: http://workstacean:3000 (resolves on shared docker net).
   * External default: process.env.WORKSTACEAN_BASE_URL.
   */
  private _pickCallbackBaseUrl(agentUrl: string | undefined): string | undefined {
    if (!agentUrl) return process.env.WORKSTACEAN_BASE_URL;
    try {
      const { hostname } = new URL(agentUrl);
      // Docker service names are single-label (no dot, not an IP).
      const isDockerInternal = !hostname.includes(".") && !hostname.includes(":");
      if (isDockerInternal) {
        return process.env.WORKSTACEAN_INTERNAL_BASE_URL ?? "http://workstacean:3000";
      }
      return process.env.WORKSTACEAN_BASE_URL;
    } catch {
      return process.env.WORKSTACEAN_BASE_URL;
    }
  }

  private async _fileTriageOnBoard(
    github: { title: string; owner?: string; repo?: string; number?: number; url?: string },
    triageSummary: string | undefined,
    projectPath: string,
  ): Promise<void> {
    const apiKey = process.env.WORKSTACEAN_API_KEY;
    const port = process.env.WORKSTACEAN_HTTP_PORT ?? "3000";
    const title = `[GH#${github.number}] ${github.title}`;
    const description = [
      `GitHub: ${github.url ?? `${github.owner}/${github.repo}#${github.number}`}`,
      "",
      "## Quinn triage summary",
      triageSummary ?? "(no triage output)",
    ].join("\n");
    try {
      const resp = await fetch(`http://localhost:${port}/api/board/features/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "X-API-Key": apiKey } : {}),
        },
        body: JSON.stringify({ projectPath, title, description, status: "backlog", source: "github-triage" }),
      });
      if (resp.ok) {
        console.log(`[skill-dispatcher] Filed GitHub triage on board: ${title}`);
      } else {
        console.warn(`[skill-dispatcher] Board filing failed: ${resp.status}`);
      }
    } catch (err) {
      console.warn("[skill-dispatcher] Board filing error:", err);
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

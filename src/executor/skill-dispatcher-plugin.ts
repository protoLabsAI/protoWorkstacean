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
import type {
  AgentSkillRequestPayload,
  AgentSkillResponsePayload,
  AutonomousOutcomePayload,
  FlowItemPayload,
  AgentActivityPayload,
  AgentActivityType,
  DispatchDroppedPayload,
  DispatchDropReason,
} from "../event-bus/payloads.ts";
import { IdentityRegistry } from "../../lib/identity/identity-registry.ts";
import { ContextMailbox } from "../../lib/dm/context-mailbox.ts";
import type { TaskTracker } from "./task-tracker.ts";
import type { A2AExecutor } from "./executors/a2a-executor.ts";

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

// ── Per-skill-per-repo cooldown ────────────────────────────────────────────────
//
// When a webhook fires bug_triage on every issue Quinn herself just filed, the
// resulting cascade can spawn 23 near-duplicate issues in 60s (see
// protoWorkstacean#556 + #558 for the surface fix at the github plugin). This
// is a defense-in-depth chokepoint at the dispatcher: even if some other
// trigger source bypasses the github filter, the same `(skill, repo)` pair
// can only dispatch once per cooldown window.
//
// Defaults: bug_triage 30s, pr_review 30s, security_triage 60s. Everything
// else: 0 (no cooldown). Override per skill with
// WORKSTACEAN_COOLDOWN_MS_<SKILL>=<ms> (case-insensitive — env var matches
// against UPPER_SNAKE of the skill name).
const DEFAULT_SKILL_COOLDOWN_MS: Record<string, number> = {
  bug_triage: 30_000,
  pr_review: 30_000,
  security_triage: 60_000,
};

/**
 * Resolve cooldown window for a skill. Env override
 * `WORKSTACEAN_COOLDOWN_MS_BUG_TRIAGE=15000` would shorten bug_triage to 15s.
 * Returns 0 for skills with no default + no env override → no cooldown.
 */
export function cooldownMsFor(skill: string): number {
  const envKey = `WORKSTACEAN_COOLDOWN_MS_${skill.toUpperCase()}`;
  const raw = process.env[envKey];
  if (raw !== undefined) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : (DEFAULT_SKILL_COOLDOWN_MS[skill] ?? 0);
  }
  return DEFAULT_SKILL_COOLDOWN_MS[skill] ?? 0;
}

/**
 * Build the cooldown bucket key for a dispatch.
 *
 * Granularity (most specific to least):
 *   `<skill>:<owner>/<repo>#<number>@<headSha7>` — pr_review on a specific
 *      PR commit. New commits always review because the headSha changes;
 *      repeated webhooks for the same SHA dedup.
 *   `<skill>:<owner>/<repo>#<number>`            — issue or PR-level
 *      (no headSha available, e.g. comment events).
 *   `<skill>:<owner>/<repo>`                     — repo-scoped (skills
 *      without a number context).
 *   `<skill>:_`                                  — no github context
 *      (chat, manual /publish, etc).
 *
 * Why each granularity matters:
 *   - PR-with-headSha keying prevents the "rebase within 30s drops the
 *     real fix" race that flagged in flow-pr-review.md.
 *   - Issue-number keying lets bug_triage rate-limit per issue, not
 *     per repo — two different issues in the same repo opening within
 *     30s both get triaged.
 *   - Repo-level fallback covers skills where neither number nor sha
 *     are meaningful (security_triage at the repo level).
 */
export function cooldownKeyFor(skill: string, payload: Record<string, unknown> | undefined): string {
  const github = (payload?.["github"] as Record<string, unknown> | undefined);
  const owner = typeof github?.["owner"] === "string" ? github["owner"] : undefined;
  const repo = typeof github?.["repo"] === "string" ? github["repo"] : undefined;
  if (!owner || !repo) return `${skill}:_`;

  const number = typeof github?.["number"] === "number" ? github["number"] : undefined;
  const headSha = typeof github?.["headSha"] === "string" ? (github["headSha"] as string) : undefined;

  let key = `${skill}:${owner}/${repo}`;
  if (number !== undefined) key += `#${number}`;
  if (headSha) key += `@${headSha.slice(0, 7)}`;
  return key;
}

export class SkillDispatcherPlugin implements Plugin {
  readonly name = "skill-dispatcher";
  readonly description = "Sole agent.skill.request subscriber — resolves executor and dispatches";
  readonly capabilities = ["skill-dispatch"];
  readonly subscribes = ["agent.skill.request"];
  readonly publishes = [
    "agent.skill.response.{correlationId}",
    "agent.skill.progress.{correlationId}",
    "autonomous.outcome.{actor}.{skill}",
    "flow.item.created",
    "flow.item.updated",
    "flow.item.completed",
    "agent.runtime.activity.skill.start",
    "agent.runtime.activity.skill.complete",
    "agent.runtime.activity.skill.error",
    "agent.skill.latency",
  ];

  private bus?: EventBus;
  private readonly subscriptionIds: string[] = [];
  private readonly identityRegistry: IdentityRegistry;
  private readonly mailbox: ContextMailbox | undefined;
  private readonly taskTracker: TaskTracker | undefined;

  /**
   * In-flight execution tracking — set at the TOP of _dispatch() (before any
   * await) so isActive() is accurate even during async work. Without this,
   * a DM debounce timer firing during dispatch could see isActive() === false
   * and dispatch a competing execution.
   */
  private readonly activeExecutions = new Map<string, { startedAt: number; skill: string }>();

  /**
   * Per-skill-per-repo cooldown bucket — see DEFAULT_SKILL_COOLDOWN_MS +
   * cooldownKeyFor() at top of file. Last dispatch time per key; consulted
   * before dispatch, updated on accept. Drops are logged loudly so they're
   * visible in the same place as the dispatch log line.
   */
  private readonly lastDispatchAt = new Map<string, number>();

  constructor(
    private readonly registry: ExecutorRegistry,
    workspaceDir: string,
    /** Optional mailbox for mid-execution DM queuing. */
    mailbox?: ContextMailbox,
    /** Optional tracker for long-running A2A tasks. */
    taskTracker?: TaskTracker,
  ) {
    this.identityRegistry = new IdentityRegistry(workspaceDir);
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

    // Per-call model override — captured for outcome cost attribution.
    // Undefined when the caller didn't override (then the executor or
    // gateway picks a model; we can't tell from here, so cost falls back
    // to the default rate downstream).
    const requestedModel = typeof payload.model === "string" ? payload.model : undefined;

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
      const dropMsg = "Received skill request with no skill — dropping";
      console.warn(`[skill-dispatcher] ${dropMsg}`);
      this._publishDispatchDropped("no_skill", correlationId, dropMsg, { targets });
      this._publishResponse(replyTopic, correlationId, undefined, "No skill specified");
      return;
    }

    const executor = this.registry.resolve(skill, targets);

    if (!executor) {
      this.activeExecutions.delete(correlationId);
      const searched = targets.length > 0
        ? `targets [${targets.join(", ")}] or skill "${skill}"`
        : `skill "${skill}"`;
      const dropMsg = `No executor found for ${searched} — dropping`;
      console.warn(`[skill-dispatcher] ${dropMsg}`);
      this._publishDispatchDropped("target_unresolved", correlationId, dropMsg, { skill, targets });
      this._publishResponse(replyTopic, correlationId, undefined, `No executor registered for ${searched}`);
      return;
    }

    // ── Per-skill-per-repo cooldown ────────────────────────────────────────
    // Defense-in-depth against cascades (protoWorkstacean#556). Same
    // (skill, repo) pair can only dispatch once per cooldown window; bucketed
    // per repo so e.g. bug_triage on protoMaker doesn't gate bug_triage on
    // protoWorkstacean. Defaults in DEFAULT_SKILL_COOLDOWN_MS; override per
    // skill via WORKSTACEAN_COOLDOWN_MS_<SKILL>.
    const cooldownMs = cooldownMsFor(skill);
    if (cooldownMs > 0) {
      const key = cooldownKeyFor(skill, payload as Record<string, unknown>);
      const last = this.lastDispatchAt.get(key);
      if (last !== undefined && Date.now() - last < cooldownMs) {
        const elapsed = Date.now() - last;
        const remaining = cooldownMs - elapsed;
        this.activeExecutions.delete(correlationId);
        const dropMsg = `Cooldown drop: "${key}" dispatched ${elapsed}ms ago (window=${cooldownMs}ms, ${remaining}ms remaining)`;
        console.warn(`[skill-dispatcher] ${dropMsg}`);
        this._publishDispatchDropped("cooldown", correlationId, dropMsg, {
          skill,
          targets,
          cooldownKey: key,
          cooldownWindowMs: cooldownMs,
          cooldownRemainingMs: remaining,
        });
        this._publishResponse(replyTopic, correlationId, undefined, `Cooldown: ${key} (${remaining}ms remaining)`);
        return;
      }
      this.lastDispatchAt.set(key, Date.now());
    }

    console.log(
      `[skill-dispatcher] Dispatching "${skill}" via ${executor.type}` +
      (targets.length > 0 ? ` (targets: ${targets.join(", ")})` : ""),
    );

    const sourceUserId: string | undefined =
      typeof msg.source?.userId === "string" ? msg.source.userId : undefined;
    const sourcePlatform: string | undefined =
      typeof msg.source?.interface === "string" ? msg.source.interface : undefined;
    const sourceChannelId: string | undefined =
      typeof msg.source?.channelId === "string" ? msg.source.channelId : undefined;
    const systemActor: string | undefined =
      typeof payload.meta?.systemActor === "string" ? payload.meta.systemActor : undefined;
    // Optional actionId / goalId stamped on meta by the caller — propagated
    // onto the autonomous-outcome event so downstream telemetry can correlate
    // dispatches with the trigger (ceremony, cron, alert handler).
    const actionId: string | undefined =
      typeof payload.meta?.actionId === "string" ? payload.meta.actionId : undefined;
    const goalId: string | undefined =
      typeof payload.meta?.goalId === "string" ? payload.meta.goalId
      : (typeof payload.goalId === "string" ? payload.goalId : undefined);
    // Name of the agent that issued this skill request (via chat_with_agent /
    // delegate_task). Carried forward to TaskTracker so input-required prompts
    // can route back to the dispatcher instead of straight to the operator.
    const dispatcherAgent: string | undefined =
      typeof payload.meta?.dispatcherAgent === "string" ? payload.meta.dispatcherAgent : undefined;

    const rawContent = typeof payload.content === "string" ? payload.content : undefined;

    const agentName = targets[0] ?? "";

    const req: SkillRequest = {
      skill,
      content: rawContent,
      prompt: typeof payload.prompt === "string" ? payload.prompt : undefined,
      correlationId,
      parentId,
      // Conversation continuity: when the caller supplies a contextId (chat
      // turns), thread it through so the executor keeps one conversation
      // instead of starting fresh on every correlationId.
      contextId: typeof payload.contextId === "string" ? payload.contextId : undefined,
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

    // Live agent telemetry — the /system dashboard subscribes to
    // agent.runtime.activity.# to render live agent state. Covers ALL
    // executor types uniformly because we emit at the dispatcher (the
    // chokepoint), not inside each executor.
    const targetAgent = targets[0] ?? "(no-target)";
    this._publishActivity("skill.start", {
      agentName: targetAgent,
      correlationId,
      skill,
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
              actionId: actionId,
              goalId: goalId,
              success: !isError,
              taskState,
              text: content,
              durationMs: Date.now() - dispatchedAt,
              model: requestedModel,
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
        //     (explicitly flagged `external: true` in agents.yaml, or
        //     hostname has a dot like `host.tailnet.ts.net:...`) use
        //     WORKSTACEAN_BASE_URL — the operator-configured public URL.
        //     The `external` flag is needed because some Tailscale hosts
        //     (e.g. `steamdeck`) use single-label MagicDNS names that the
        //     hostname-shape heuristic can't distinguish from docker services.
        const callbackBaseUrl = this._pickCallbackBaseUrl(a2aExecutor.url, a2aExecutor.external);
        if (callbackBaseUrl && a2aExecutor.pushNotifications) {
          const callbackUrl = `${callbackBaseUrl.replace(/\/$/, "")}/api/a2a/callback/${encodeURIComponent(taskId)}`;
          void a2aExecutor.registerPushNotification(taskId, callbackUrl, callbackToken, correlationId, parentId)
            .then(ok => {
              if (ok) console.log(`[skill-dispatcher] Push-notification registered for ${taskId.slice(0, 8)}… at ${callbackUrl}`);
              // Failure path is logged by A2AExecutor.registerPushNotification with agent + reason.
            })
            .catch(err => console.log("[skill-dispatcher] push-notification register failed:", err));
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
        this._publishActivity("skill.error", {
          agentName: targetAgent,
          correlationId,
          skill,
          errorMessage: (result.text ?? "").slice(0, 500),
          durationMs: Date.now() - dispatchedAt,
        });
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
          actionId: actionId,
          goalId: goalId,
          success: false,
          taskState: result.data?.taskState ?? "failed",
          text: result.text,
          usage: result.data?.usage,
          durationMs: Date.now() - dispatchedAt,
          model: requestedModel,
        });
      } else {
        // Log a preview of the response so we can see what the executor actually
        // returned — critical for debugging A2A/agent behaviour when the skill
        // completes but produces no board side-effects.
        const preview = (result.text ?? "").replace(/\s+/g, " ").slice(0, 300);
        console.log(
          `[skill-dispatcher] Skill "${skill}" completed via ${executor.type} — ${(result.text ?? "").length} chars: ${preview}${(result.text ?? "").length > 300 ? "…" : ""}`,
        );

        // Trigger-to-done latency. When a surface plugin (today: github
        // _handleAutoReview) stamps payload.meta.webhookArrivedAt, surface
        // the full webhook→done duration split into queue time vs execute
        // time. A separate single-line summary so it's grep-friendly and
        // independent of the completion-text-preview log above.
        const webhookArrivedAt = typeof payload.meta?.webhookArrivedAt === "number"
          ? payload.meta.webhookArrivedAt
          : undefined;
        if (webhookArrivedAt) {
          const now = Date.now();
          const totalMs = now - webhookArrivedAt;
          const queueMs = dispatchedAt - webhookArrivedAt;
          const executeMs = now - dispatchedAt;
          const gh = payload.github as { owner?: string; repo?: string; number?: number } | undefined;
          const repoRef = gh?.owner && gh?.repo && gh?.number
            ? ` [${gh.owner}/${gh.repo}#${gh.number}]`
            : "";
          console.log(
            `[skill-latency] ${skill} webhook→done ${(totalMs / 1000).toFixed(2)}s ` +
              `(queue ${queueMs}ms, execute ${(executeMs / 1000).toFixed(2)}s)${repoRef}`,
          );

          // Structured form of the same data for dashboard tiles + future
          // alerting subscribers (see all-topics.ts AGENT_SKILL_LATENCY).
          // Best-effort: a publish failure must not poison the success path
          // we're already on.
          if (this.bus) {
            try {
              this.bus.publish("agent.skill.latency", {
                id: crypto.randomUUID(),
                correlationId,
                topic: "agent.skill.latency",
                timestamp: now,
                payload: {
                  skill,
                  totalMs,
                  queueMs,
                  executeMs,
                  github: gh?.owner && gh?.repo && gh?.number
                    ? { owner: gh.owner, repo: gh.repo, number: gh.number }
                    : undefined,
                },
              });
            } catch (err) {
              console.warn(
                `[skill-dispatcher] failed to publish agent.skill.latency: ${err instanceof Error ? err.message : err}`,
              );
            }
          }
        }

        this._publishActivity("skill.complete", {
          agentName: targetAgent,
          correlationId,
          skill,
          resultPreview: preview.slice(0, 120),
          durationMs: Date.now() - dispatchedAt,
        });
        if (result.data?.stopReason === "max_turns") {
          console.warn("[skill-dispatcher] Agent hit maxTurns limit");
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
          actionId: actionId,
          goalId: goalId,
          success: true,
          taskState: result.data?.taskState ?? "completed",
          text: result.text,
          usage: result.data?.usage,
          durationMs,
          model: requestedModel,
        });
      }

      this._publishResponse(
        replyTopic,
        correlationId,
        result.isError ? undefined : result.text,
        result.isError ? result.text || "Executor error" : undefined,
        {
          taskState: (typeof result.data?.taskState === "string"
            ? result.data.taskState
            : (result.isError ? "failed" : "completed")),
          ...(typeof result.data?.taskId === "string" ? { taskId: result.data.taskId } : {}),
          ...(typeof result.data?.contextId === "string" ? { contextId: result.data.contextId } : {}),
          ...(result.data?.usage ? { usage: result.data.usage as AgentSkillResponsePayload["usage"] } : {}),
          ...(typeof result.data?.costUsd === "number" ? { costUsd: result.data.costUsd } : {}),
          ...(typeof result.data?.confidence === "number" ? { confidence: result.data.confidence } : {}),
          ...(typeof result.data?.confidenceExplanation === "string"
            ? { confidenceExplanation: result.data.confidenceExplanation } : {}),
          durationMs: Date.now() - dispatchedAt,
        },
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[skill-dispatcher] Unhandled error dispatching "${skill}": ${errorMsg}`);
      this._publishActivity("skill.error", {
        agentName: targetAgent,
        correlationId,
        skill,
        errorMessage: errorMsg,
        durationMs: Date.now() - dispatchedAt,
      });
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
        actionId: actionId,
        goalId: goalId,
        success: false,
        taskState: "failed",
        text: errorMsg,
        durationMs: Date.now() - dispatchedAt,
        model: requestedModel,
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
    model?: string;
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
      model: opts.model,
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
  private _pickCallbackBaseUrl(agentUrl: string | undefined, external: boolean = false): string | undefined {
    // Explicit opt-out: agent runs off-network (Tailscale / public), so the
    // docker-internal callback won't reach it. Use the operator-configured
    // external URL regardless of hostname shape.
    if (external) return process.env.WORKSTACEAN_BASE_URL;

    if (!agentUrl) return process.env.WORKSTACEAN_BASE_URL;
    try {
      const { hostname } = new URL(agentUrl);
      // Docker service names are single-label (no dot, not an IP). This
      // heuristic is correct for quinn / jon / researcher but incorrect for
      // single-label Tailscale MagicDNS hostnames — those agents must set
      // `external: true` in workspace/agents.yaml.
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

  /**
   * Publish a live agent activity event. Best-effort: any failure to publish
   * is swallowed — telemetry must never break a running skill. The /system
   * dashboard subscribes to `agent.runtime.activity.#` to render live agent
   * state, but any other consumer is welcome.
   */
  private _publishActivity(type: AgentActivityType, fields: Omit<AgentActivityPayload, "type" | "timestamp">): void {
    if (!this.bus) return;
    const topic = `agent.runtime.activity.${type}`;
    const payload: AgentActivityPayload = {
      type,
      timestamp: Date.now(),
      ...fields,
    };
    try {
      this.bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: fields.correlationId,
        topic,
        timestamp: payload.timestamp,
        payload,
      });
    } catch (err) {
      console.warn(`[skill-dispatcher] activity-publish failed (${type}):`, err);
    }
  }

  private _publishResponse(
    replyTopic: string,
    correlationId: string,
    result: string | undefined,
    error: string | undefined,
    extra?: Omit<Partial<AgentSkillResponsePayload>, "content" | "error" | "correlationId">,
  ): void {
    if (!this.bus) return;
    this.bus.publish(replyTopic, {
      id: crypto.randomUUID(),
      correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: { content: result, error, correlationId, ...extra },
    });
  }

  /**
   * Publish a dispatch-dropped telemetry event at the matching chokepoint
   * site. Topic is `dispatch.dropped.{reason}` so subscribers can filter
   * by reason. The console.warn is kept alongside this for log-tail
   * visibility — both paths fire independently.
   */
  private _publishDispatchDropped(
    reason: DispatchDropReason,
    correlationId: string,
    message: string,
    extra: Omit<DispatchDroppedPayload, "reason" | "correlationId" | "message">,
  ): void {
    if (!this.bus) return;
    const topic = `dispatch.dropped.${reason}`;
    const payload: DispatchDroppedPayload = {
      reason,
      correlationId,
      message,
      ...extra,
    };
    this.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId,
      topic,
      timestamp: Date.now(),
      payload,
    });
  }
}

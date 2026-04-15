/**
 * GoalHotReloadPlugin — the adaptive half of the growth loop.
 *
 * Listens for completed goal_proposal skill executions, presents the
 * proposed goals.yaml entry to a human via the HITL gate, and on
 * approval appends the entry to workspace/goals.yaml then publishes
 * goals.reload so GoalEvaluatorPlugin picks it up without a restart.
 *
 * Flow:
 *   1. agent.skill.request { skill: 'goal_proposal' }
 *      → GoalHotReloadPlugin notes the correlationId
 *   2. agent.skill.response.{correlationId} arrives with Ava's proposed YAML
 *      → plugin raises hitl.request.{correlationId} for human review
 *   3. hitl.response.{correlationId} arrives with decision "approve"
 *      → plugin extracts the YAML block, appends to goals.yaml, publishes goals.reload
 *
 * Inbound:
 *   agent.skill.request          — detect goal_proposal requests
 *   agent.skill.response.#       — capture Ava's proposed YAML text
 *   hitl.response.#              — receive human decision
 *
 * Outbound:
 *   hitl.request.{correlationId} — HITL approval gate
 *   goals.reload                 — trigger GoalEvaluatorPlugin to re-read goals.yaml
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Plugin, EventBus, BusMessage, HITLRequest, HITLResponse } from "../../lib/types.ts";
import type { AgentSkillRequestPayload } from "../event-bus/payloads.ts";
import type { AgentSkillResponsePayload } from "../event-bus/payloads.ts";

const HITL_TTL_MS = 30 * 60_000; // 30 min window for human review

export class GoalHotReloadPlugin implements Plugin {
  readonly name = "goal-hot-reload";
  readonly description = "Captures goal_proposal results, gates on HITL approval, appends to goals.yaml on approve";
  readonly capabilities = ["goal-hot-reload"];

  private bus?: EventBus;
  private readonly subscriptionIds: string[] = [];

  /**
   * correlationIds of in-flight goal_proposal skill requests.
   * Populated on agent.skill.request, consumed on agent.skill.response.
   */
  private readonly pendingProposals = new Set<string>();

  /**
   * Proposed YAML content keyed by correlationId — stored between the
   * skill response arriving and the HITL decision returning.
   */
  private readonly pendingApprovals = new Map<string, string>();

  constructor(private readonly workspaceDir: string) {}

  install(bus: EventBus): void {
    this.bus = bus;

    // 1. Track goal_proposal skill requests
    this.subscriptionIds.push(
      bus.subscribe("agent.skill.request", this.name, (msg: BusMessage) => {
        const payload = msg.payload as AgentSkillRequestPayload | undefined;
        if (payload?.skill !== "goal_proposal") return;
        this.pendingProposals.add(msg.correlationId);
        console.log(
          `[goal-hot-reload] Tracking goal_proposal request (${msg.correlationId.slice(0, 8)}…)`,
        );
      }),
    );

    // 2. Capture the skill response and raise HITL
    this.subscriptionIds.push(
      bus.subscribe("agent.skill.response.#", this.name, (msg: BusMessage) => {
        const payload = msg.payload as AgentSkillResponsePayload | undefined;
        const correlationId = payload?.correlationId ?? msg.correlationId;
        if (!this.pendingProposals.has(correlationId)) return;
        this.pendingProposals.delete(correlationId);

        const content = payload?.content;
        if (!content) {
          console.warn(
            `[goal-hot-reload] goal_proposal (${correlationId.slice(0, 8)}…) returned empty — skipping HITL`,
          );
          return;
        }

        // Extract the fenced YAML block from Ava's response
        const yamlBlock = this._extractYamlBlock(content);
        if (!yamlBlock) {
          console.warn(
            `[goal-hot-reload] goal_proposal (${correlationId.slice(0, 8)}…) contained no YAML block — skipping HITL`,
          );
          return;
        }

        this.pendingApprovals.set(correlationId, yamlBlock);
        this._raiseHitl(correlationId, content);
      }),
    );

    // 3. Handle human decision
    this.subscriptionIds.push(
      bus.subscribe("hitl.response.#", this.name, (msg: BusMessage) => {
        const resp = msg.payload as HITLResponse | undefined;
        if (resp?.type !== "hitl_response") return;
        const yamlBlock = this.pendingApprovals.get(resp.correlationId);
        if (!yamlBlock) return; // not a goal_proposal approval

        this.pendingApprovals.delete(resp.correlationId);

        if (resp.decision !== "approve") {
          console.log(
            `[goal-hot-reload] Goal proposal (${resp.correlationId.slice(0, 8)}…) ${resp.decision}d — not writing`,
          );
          return;
        }

        try {
          this._appendGoal(yamlBlock, resp.feedback);
          console.log(
            `[goal-hot-reload] Goal proposal approved by ${resp.decidedBy} — appended to goals.yaml, publishing goals.reload`,
          );
          this._publishReload();
        } catch (err) {
          console.error("[goal-hot-reload] Failed to append goal to goals.yaml:", err);
        }
      }),
    );

    console.log("[goal-hot-reload] Installed");
  }

  uninstall(): void {
    if (this.bus) {
      for (const id of this.subscriptionIds) {
        this.bus.unsubscribe(id);
      }
    }
    this.subscriptionIds.length = 0;
    this.pendingProposals.clear();
    this.pendingApprovals.clear();
    this.bus = undefined;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Extract the first fenced ```yaml block from Ava's response text.
   * Returns the content inside the fence (without the ``` lines).
   */
  private _extractYamlBlock(text: string): string | undefined {
    const match = text.match(/```ya?ml\n([\s\S]*?)```/);
    return match?.[1]?.trim();
  }

  /**
   * Raise a HITL request so the human can review and approve/reject the proposed goal.
   */
  private _raiseHitl(correlationId: string, fullResponse: string): void {
    if (!this.bus) return;

    const req: HITLRequest = {
      type: "hitl_request",
      correlationId,
      title: "New goal proposed by Ava — review and approve?",
      summary: fullResponse,
      options: ["approve", "reject"],
      expiresAt: new Date(Date.now() + HITL_TTL_MS).toISOString(),
      replyTopic: `hitl.response.${correlationId}`,
      sourceMeta: {
        interface: "discord",
      },
    };

    this.bus.publish(`hitl.request.${correlationId}`, {
      id: crypto.randomUUID(),
      correlationId,
      topic: `hitl.request.${correlationId}`,
      timestamp: Date.now(),
      payload: req,
    });

    console.log(
      `[goal-hot-reload] Raised HITL review for goal_proposal (${correlationId.slice(0, 8)}…)`,
    );
  }

  /**
   * Append the proposed goal entry to workspace/goals.yaml.
   * Preserves the existing file content and adds the new entry under the goals: list.
   */
  private _appendGoal(yamlBlock: string, feedback?: string): void {
    const goalsPath = join(this.workspaceDir, "goals.yaml");
    if (!existsSync(goalsPath)) {
      throw new Error(`goals.yaml not found at ${goalsPath}`);
    }

    const existing = readFileSync(goalsPath, "utf8");

    // Normalize indentation: ensure the block is indented with 2 spaces
    // (the goals.yaml list items use 2-space indentation under goals:)
    const normalized = yamlBlock
      .split("\n")
      .map(line => (line.startsWith("  ") ? line : `  ${line}`))
      .join("\n");

    const comment = feedback
      ? `\n  # Proposed by Ava — approved with feedback: ${feedback}\n`
      : `\n  # Proposed by Ava via goal_proposal skill — auto-approved\n`;

    const appended = `${existing.trimEnd()}\n${comment}${normalized}\n`;
    writeFileSync(goalsPath, appended, "utf8");
  }

  private _publishReload(): void {
    if (!this.bus) return;
    this.bus.publish("goals.reload", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "goals.reload",
      timestamp: Date.now(),
      payload: { source: "goal-hot-reload" },
    });
  }
}

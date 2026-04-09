/**
 * WorkflowExecutor — executes a sequence of bus publishes as a skill.
 *
 * Each step publishes a message to the bus and optionally waits for a
 * reply before proceeding. Steps share the same correlationId so the
 * entire workflow appears as a single trace.
 *
 * Use for multi-step orchestration that doesn't require an LLM agent —
 * e.g. "trigger CI, wait for result, post to Discord".
 */

import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";
import type { EventBus } from "../../../lib/types.ts";

export interface WorkflowStep {
  /** Bus topic to publish to. */
  topic: string;
  /** Build the message payload from the skill request + previous step results. */
  buildPayload: (req: SkillRequest, previousResults: unknown[]) => Record<string, unknown>;
  /**
   * If set, wait for a reply on this topic before continuing.
   * Receives the reply payload and returns whether to continue or abort.
   */
  replyTopic?: string;
  replyTimeoutMs?: number;
  onReply?: (payload: unknown, previousResults: unknown[]) => { continue: boolean; result?: unknown };
}

export class WorkflowExecutor implements IExecutor {
  readonly type = "workflow";

  constructor(
    private readonly bus: EventBus,
    private readonly steps: WorkflowStep[],
  ) {}

  async execute(req: SkillRequest): Promise<SkillResult> {
    const results: unknown[] = [];

    for (const step of this.steps) {
      const msgId = crypto.randomUUID();
      const payload = step.buildPayload(req, results);

      this.bus.publish(step.topic, {
        id: msgId,
        correlationId: req.correlationId,
        parentId: req.parentId,
        topic: step.topic,
        timestamp: Date.now(),
        payload,
      });

      if (step.replyTopic) {
        const replyPayload = await this._waitForReply(
          step.replyTopic,
          step.replyTimeoutMs ?? 30_000,
        );

        if (step.onReply) {
          const decision = step.onReply(replyPayload, results);
          results.push(decision.result ?? replyPayload);
          if (!decision.continue) {
            return {
              text: `Workflow stopped at step "${step.topic}"`,
              isError: false,
              correlationId: req.correlationId,
              data: { results, stoppedAt: step.topic },
            };
          }
        } else {
          results.push(replyPayload);
        }
      }
    }

    return {
      text: `Workflow completed (${this.steps.length} step(s))`,
      isError: false,
      correlationId: req.correlationId,
      data: { results },
    };
  }

  private _waitForReply(topic: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.bus.unsubscribe(subId);
          resolve(null);
        }
      }, timeoutMs);

      const subId = this.bus.subscribe(topic, `workflow-executor-${topic}`, (msg) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          this.bus.unsubscribe(subId);
          resolve(msg.payload);
        }
      });
    });
  }
}

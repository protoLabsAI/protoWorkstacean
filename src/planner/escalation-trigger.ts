/**
 * EscalationTrigger — decides when to escalate from L2 to L3 (human).
 *
 * Triggers escalation when confidence is below threshold or borderline.
 * Borderline plans (within margin of threshold) are flagged for lightweight review.
 */

import type { ConfidenceScore, } from "./routing-interface.ts";
import { DEFAULT_ROUTING_CONFIG } from "./routing-interface.ts";

/** Result of an escalation evaluation. */
export interface EscalationEvaluation {
  shouldEscalate: boolean;
  /** Plan is near the threshold — may warrant lightweight confirmation. */
  isBorderline: boolean;
  reason: string;
  confidence: number;
  threshold: number;
}

export class EscalationTrigger {
  private threshold: number;
  private borderlineMargin: number;

  constructor(
    threshold?: number,
    borderlineMargin: number = 0.05,
  ) {
    this.threshold = threshold ?? DEFAULT_ROUTING_CONFIG.l2ConfidenceThreshold;
    this.borderlineMargin = borderlineMargin;
  }

  /**
   * Evaluate whether an L2 result should be escalated to L3.
   */
  evaluate(confidence: ConfidenceScore): EscalationEvaluation {
    const { overall } = confidence;

    if (overall < this.threshold) {
      return {
        shouldEscalate: true,
        isBorderline: false,
        reason: `Confidence ${overall.toFixed(3)} below threshold ${this.threshold}`,
        confidence: overall,
        threshold: this.threshold,
      };
    }

    const isBorderline = overall < this.threshold + this.borderlineMargin;
    if (isBorderline) {
      return {
        shouldEscalate: false,
        isBorderline: true,
        reason: `Confidence ${overall.toFixed(3)} is borderline (within ${this.borderlineMargin} of threshold ${this.threshold})`,
        confidence: overall,
        threshold: this.threshold,
      };
    }

    return {
      shouldEscalate: false,
      isBorderline: false,
      reason: `Confidence ${overall.toFixed(3)} above threshold ${this.threshold}`,
      confidence: overall,
      threshold: this.threshold,
    };
  }

  /** Update threshold at runtime (e.g., from config hot-reload). */
  setThreshold(threshold: number): void {
    this.threshold = threshold;
  }

  /** Get current threshold. */
  getThreshold(): number {
    return this.threshold;
  }
}

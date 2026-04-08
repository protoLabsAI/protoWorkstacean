/**
 * RuleAuditor — audit trail for rule lifecycle events.
 *
 * Logs all rule creation, promotion, rollback, and deactivation events
 * for compliance and debugging.
 */

/** Types of audit events. */
export type AuditEventType = "create" | "promote" | "rollback" | "deactivate" | "update" | "prune";

/** An audit log entry. */
export interface AuditEvent {
  ruleId: string;
  type: AuditEventType;
  timestamp: number;
  version: number;
  details: string;
}

export class RuleAuditor {
  private events: AuditEvent[] = [];
  private maxEvents: number;

  constructor(maxEvents: number = 10000) {
    this.maxEvents = maxEvents;
  }

  /**
   * Log an audit event.
   */
  logEvent(event: AuditEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  /**
   * Get all events for a rule.
   */
  getForRule(ruleId: string): AuditEvent[] {
    return this.events.filter((e) => e.ruleId === ruleId);
  }

  /**
   * Get events by type.
   */
  getByType(type: AuditEventType): AuditEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  /**
   * Get recent events (last N).
   */
  getRecent(limit: number = 50): AuditEvent[] {
    return this.events.slice(-limit);
  }

  /**
   * Get all events in a time range.
   */
  getInRange(startMs: number, endMs: number): AuditEvent[] {
    return this.events.filter((e) => e.timestamp >= startMs && e.timestamp <= endMs);
  }

  /**
   * Get all events.
   */
  getAll(): readonly AuditEvent[] {
    return this.events;
  }

  /** Clear all events. */
  clear(): void {
    this.events.length = 0;
  }
}

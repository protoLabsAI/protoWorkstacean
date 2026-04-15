export interface BusMessage {
  id: string;
  correlationId: string;
  parentId?: string;
  topic: string;
  timestamp: number;
  payload: unknown;
  // source: where this message originated
  source?: {
    interface: "discord" | "slack" | "voice" | "github" | "plane" | "api" | string;
    channelId?: string;
    userId?: string;
  };
  // reply: where responses (including HITLRequest) should be published
  reply?: {
    topic: string;
    format?: "markdown" | "plain" | "voice" | "structured";
  };
  /** @deprecated Use payload.content for text and reply.topic for routing. */
  replyTo?: string;
}

// ── HITL (human-in-the-loop) gate types ──────────────────────────────────────

export interface HITLRequest {
  type: "hitl_request";
  correlationId: string;
  title: string;
  summary: string;
  avaVerdict?: { score: number; concerns: string[]; verdict: string };
  jonVerdict?: { score: number; concerns: string[]; verdict: string };
  options: string[];      // ["approve", "reject", "modify"]
  expiresAt: string;      // ISO timestamp
  /** Optional TTL override in milliseconds. Callers may compute expiresAt from this. */
  ttlMs?: number;
  /** Policy to execute when the TTL expires without a human decision. */
  onTimeout?: "approve" | "reject" | "escalate";
  /**
   * Compound-gate metadata (Arc 7.3). When a single A2A task emits multiple
   * input-required states across its lifecycle (e.g. draft → review → publish),
   * each prompt sets `checkpoint` so renderers can show "Checkpoint 2 of 3"
   * instead of a bare "input-required".
   */
  checkpoint?: {
    /** 1-based index of this prompt within the task's compound sequence. */
    index: number;
    /** Optional agent-declared total; may be unknown at the first prompt. */
    total?: number;
  };
  replyTopic: string;     // where to publish HITLResponse
  sourceMeta?: BusMessage["source"]; // carry source through so HITL plugin knows how to render
  // ── Cost escalation fields (populated by BudgetPlugin L3 requests) ────────
  escalation_reason?: string;
  cost_trail?: Array<{
    id: string;
    timestamp: number;
    tier: string;
    estimatedCost: number;
    wasEscalated: boolean;
  }>;
  escalationContext?: {
    estimatedCost: number;
    maxCost: number;
    tier: string;
    budgetState: {
      remainingProjectBudget: number;
      remainingDailyBudget: number;
      projectBudgetRatio: number;
      dailyBudgetRatio: number;
    };
  };
}

export interface HITLResponse {
  type: "hitl_response";
  correlationId: string;
  decision: "approve" | "reject" | "modify";
  feedback?: string;
  decidedBy: string;
}

/**
 * HITLRenderer — the contract a channel plugin implements to participate in
 * HITL flows. Register during install() via hitlPlugin.registerRenderer().
 *
 * render()     — called when a new HITLRequest arrives for this interface.
 *                Post the approval UI to your platform. When the user decides,
 *                publish hitl.response.{ns}.{correlationId} to the bus.
 *
 * onExpired()  — called when the request TTL expires before a decision.
 *                Clean up the UI (disable buttons, post expiry notice, etc.).
 */
export interface HITLRenderer {
  render(request: HITLRequest, bus: EventBus): Promise<void>;
  onExpired?(request: HITLRequest, bus: EventBus): Promise<void>;
}

// ── Config-change gate types (Arc 9.3) ────────────────────────────────────────
// Distinct from HITLRequest so operators see "this changes the rules of the
// system" vs "this is a one-shot operational approval".

export interface ConfigChangeRequest {
  type: "config_change_request";
  correlationId: string;
  /** Which workspace config file is being changed. */
  configFile: "goals.yaml" | "actions.yaml";
  title: string;
  summary: string;
  /** Unified diff of the proposed change (before → after). */
  yamlDiff: string;
  /** Dry-run GOAP impact — which goals/actions are affected. */
  goapImpact?: {
    addedGoals?: string[];
    removedGoals?: string[];
    modifiedGoals?: string[];
    addedActions?: string[];
    removedActions?: string[];
    modifiedActions?: string[];
    /** Human-readable GOAP evaluation summary. */
    summary: string;
  };
  /** Test coverage impact summary. */
  coverageImpact?: {
    affectedTestFiles: string[];
    summary: string;
  };
  options: string[];   // ["approve", "reject"]
  expiresAt: string;   // ISO timestamp
  replyTopic: string;  // where to publish ConfigChangeResponse
  sourceMeta?: BusMessage["source"];
}

export interface ConfigChangeResponse {
  type: "config_change_response";
  correlationId: string;
  decision: "approve" | "reject";
  feedback?: string;
  decidedBy: string;
}

/**
 * ConfigChangeRenderer — contract for interface plugins that want to surface
 * config-change approval requests. Mirrors the HITLRenderer shape but is
 * distinct so operators can visually separate "rules are changing" flows from
 * "one-shot approval" flows.
 */
export interface ConfigChangeRenderer {
  render(request: ConfigChangeRequest, bus: EventBus): Promise<void>;
  onExpired?(request: ConfigChangeRequest, bus: EventBus): Promise<void>;
}

export interface WidgetDescriptor {
  pluginName: string;
  widgetId: string;
  type: string;
  title: string;
  props: Record<string, unknown>;
}

export interface Plugin {
  name: string;
  description: string;
  capabilities: string[];
  install(bus: EventBus): void;
  uninstall(): void;
  getWidgets?(): WidgetDescriptor[];
}

export interface TopicInfo {
  pattern: string;
  subscribers: number;
}

export interface ConsumerInfo {
  name: string;
  subscriptions: string[];
  capabilities: string[];
}

export interface Subscription {
  id: string;
  pattern: string;
  pluginName: string;
  handler: MessageHandler;
}

export type MessageHandler = (message: BusMessage) => void | Promise<void>;

export interface EventBus {
  publish(topic: string, message: BusMessage): void;
  subscribe(pattern: string, pluginName: string, handler: MessageHandler): string;
  unsubscribe(id: string): void;
  topics(): TopicInfo[];
  consumers(): ConsumerInfo[];
}
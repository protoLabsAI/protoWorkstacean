export interface BusMessage {
  id: string;
  correlationId: string;
  parentId?: string;
  topic: string;
  timestamp: number;
  payload: unknown;
  // source: where this message originated
  source?: {
    interface: "discord" | "slack" | "voice" | "github" | "linear" | "google" | "api" | string;
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

/**
 * Evidence block required for data-driven config change proposals
 * (e.g. from the tuning agent). Forces proposers to carry their work —
 * approvers see sample counts, baseline metrics, and which skills are
 * affected, so they can reason about whether the change is statistically
 * warranted vs. chasing noise.
 */
export interface ConfigChangeEvidence {
  /** Number of samples backing the proposed change. Gated server-side at >= 50. */
  sampleCount: number;
  /** Current observed metric (e.g. "successRate=0.45, avgConfidence=0.72"). */
  baselineMetric: string;
  /** Expected delta (e.g. "target: successRate>=0.7 via explicit CI-status prompt"). */
  proposedDelta: string;
  /** Skill names whose behavior this change affects. */
  affectedSkills: string[];
  /** Free-text rationale. */
  rationale?: string;
}

/**
 * Change target for an agent-YAML proposal. Only in-process agent files
 * can be targeted (goals/actions use their own configFile variants).
 */
export interface ConfigChangeAgentTarget {
  type: "agent";
  /** Name of the agent — resolves to `workspace/agents/<agentName>.yaml`. */
  agentName: string;
}

export interface ConfigChangeRequest {
  type: "config_change_request";
  correlationId: string;
  /**
   * Which workspace config file is being changed. Goals + actions use string
   * literals; agent-YAML changes use a structured target so the approver can
   * see which agent is affected without parsing a path.
   */
  configFile: "goals.yaml" | "actions.yaml" | ConfigChangeAgentTarget;
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
  /**
   * Evidence backing the proposal — required for data-driven proposals
   * (tuning agent). Optional for operator-authored proposals where the
   * operator's judgment is the evidence.
   */
  evidence?: ConfigChangeEvidence;
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

// ── Logger turn-query capability ──────────────────────────────────────────────
// Topic: logger.turn.query
// Any plugin may publish a LoggerTurnQueryRequest. LoggerPlugin subscribes to
// "logger.turn.query", resolves the turns, and publishes a
// LoggerTurnQueryResponse to the replyTopic.

export interface LoggerTurnQueryRequest {
  type: "logger.turn.query";
  /** Canonical user ID (matches BusMessage.source.userId). */
  userId: string;
  /** Agent name to scope turns to. Pass empty string for any agent. */
  agentName: string;
  /** Maximum number of conversation turns (not pairs) to return. */
  limit: number;
  /** Only include turns within this many ms of now. */
  maxAgeMs: number;
  /** Topic where LoggerPlugin publishes the LoggerTurnQueryResponse. */
  replyTopic: string;
}

export interface LoggerTurnQueryResponse {
  type: "logger.turn.query.response";
  turns: ConversationTurn[];
}

// ── ConversationTurn ──────────────────────────────────────────────────────────

export interface ConversationTurn {
  timestamp: number;
  role: "user" | "assistant";
  text: string;
  agentName: string;
  channelId: string;
}

export type WidgetType = 'chart' | 'table' | 'status-card' | 'log-stream' | 'metric';

export interface WidgetDescriptor {
  /** Plugin that contributed this widget — stamped by /api/widgets discovery from plugin.name. */
  pluginName: string;
  id: string;
  type: WidgetType;
  title: string;
  query?: string;
  props?: Record<string, unknown>;
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
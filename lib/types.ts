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
  // reply: where responses should be published
  reply?: {
    topic: string;
    format?: "markdown" | "plain" | "voice" | "structured";
  };
  /** @deprecated Use payload.content for text and reply.topic for routing. */
  replyTo?: string;
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
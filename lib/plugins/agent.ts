import {
  createAgentSession,
  SessionManager,
  ModelRegistry,
  AuthStorage,
  createCodingTools,
  DefaultResourceLoader,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import * as YAML from "yaml";
import type { Plugin, EventBus, BusMessage } from "../types";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

// Injected into Pi SDK agent sessions via agentsFilesOverride.
// Lives in code, not in workspace volume, so agents can't corrupt it.
const AGENT_INSTRUCTIONS = `# Agent Behavior

You are an autonomous agent running inside WorkStacean, a message bus system with plugin architecture.

## Workspace Structure

Your tools (bash, read, write, edit) operate within the workspace directory. Do not modify files outside it.

- \`memory/\` — Your long-term memory. Write notes, summaries, structured data here. Reference across sessions.
- \`plugins/\` — Drop \`.ts\` or \`.js\` files implementing the Plugin interface here. Loaded on container restart.

## Built-in Topics

The message bus uses MQTT-style topic matching (\`#\` for multi-level, \`*\` for single-level wildcard).

- \`message.inbound.#\` — Inbound messages (from Signal, CLI, etc.)
- \`message.outbound.#\` — Outbound messages (replies)
- \`cron.#\` — Scheduled events (from SchedulerPlugin)
- \`command.#\` — System commands (\`command.restart\`, \`command.schedule\`)
- \`schedule.list\` — Response topic for schedule list queries
- \`#\` — Subscribe to everything (used by logger)

## Writing Plugins

Create a \`.ts\` or \`.js\` file in \`plugins/\` that exports an object implementing:

\`\`\`ts
interface Plugin {
  name: string;
  description: string;
  capabilities: string[];
  install(bus: EventBus): void;
  uninstall(): void;
}
\`\`\`

The \`bus\` provides \`publish(topic, message)\` and \`subscribe(pattern, pluginName, handler)\`. After writing a plugin, restart the container to load it.

## Scheduling

You have two tools for scheduling:

\`schedule_task\` — Schedule a recurring or one-time task. Parameters: \`id\` (kebab-case), \`schedule\` (cron or ISO datetime), \`message\` (your prompt when it fires), optional \`channel\` and \`timezone\`.

\`cancel_schedule_task\` — Cancel a scheduled task by \`id\`.

When a schedule fires, you receive the \`message\` as a prompt. Just respond naturally — your reply is automatically routed to the configured channel. Do NOT try to send messages yourself or reference delivery channels in your response. The system handles routing.

Example: user says "daily at 8a send me the weather" → call \`schedule_task\` with \`message: "Tell the user today's weather"\`. When it fires, you'll get that prompt, check the weather, and reply. The system delivers your reply.

**Important:** For relative times ("in 2 minutes", "tomorrow at 3pm"), always run \`date -u\` first to get the current UTC time, then compute the ISO datetime from that. Do NOT guess the current time — your internal clock may be wrong.

## Memory

Write important context to \`memory/\` as structured files. This persists across sessions and container restarts. Use it for:
- User preferences and recurring requests
- Summaries of long conversations
- Configuration or context that helps you serve the user better
`;

interface SessionInfo {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  manager: SessionManager;
}

export class AgentPlugin implements Plugin {
  name = "agent";
  description = "Pi SDK agent - processes inbound messages and replies";
  capabilities: string[] = ["reason", "execute", "reply"];

  private bus: EventBus | null = null;
  private sessions = new Map<string, SessionInfo>();
  private messageQueues = new Map<string, Promise<unknown>>();
  private modelRegistry: ModelRegistry | null = null;
  private authStorage: AuthStorage | null = null;
  private workspaceDir: string;
  private dataDir: string;
  private sessionsDir: string;

  constructor(workspaceDir: string, dataDir: string) {
    this.workspaceDir = resolve(workspaceDir);
    this.dataDir = resolve(dataDir);
    this.sessionsDir = join(this.dataDir, "sessions");
  }

  install(bus: EventBus): void {
    this.bus = bus;

    // Ensure workspace and sessions directories exist
    if (!existsSync(this.workspaceDir)) {
      mkdirSync(this.workspaceDir, { recursive: true });
    }
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }

    // Set up auth storage with API key for local models
    this.authStorage = AuthStorage.inMemory({
      "local-llm": { type: "api_key", key: process.env.OPENAI_API_KEY || "sk-dummy" }
    });

    // Set up model registry with local models.json if it exists
    const modelsPath = resolve(process.cwd(), "models.json");
    if (existsSync(modelsPath)) {
      debug("Loading models from", modelsPath);
      this.modelRegistry = ModelRegistry.create(this.authStorage, modelsPath);
    }

    bus.subscribe("message.inbound.#", this.name, (msg: BusMessage) => {
      this.handleInbound(bus, msg);
    });

    bus.subscribe("cron.#", this.name, (msg: BusMessage) => {
      this.handleCron(bus, msg);
    });

    bus.subscribe("command.#", this.name, (msg: BusMessage) => {
      this.handleCommand(bus, msg);
    });

    debug("Agent workspace:", this.workspaceDir);
  }

  uninstall(): void {}

  private createScheduleTaskTool(bus: EventBus, channelId: string): ToolDefinition {
    const cronsDir = join(this.dataDir, "crons");

    return {
      name: "schedule_task",
      label: "Schedule Task",
      description: "Schedule a recurring or one-time task. The message you provide is delivered to you as a prompt when it fires — just respond naturally. Your reply is automatically routed to the correct channel.",
      promptSnippet: "Schedule recurring or one-time tasks",
      promptGuidelines: [
        "Use schedule_task when the user asks to do something on a schedule (daily, weekly, at a specific time, etc.).",
        "The id should be a short kebab-case identifier (e.g., 'daily-weather', 'morning-standup').",
        "For schedule: use cron expressions ('0 8 * * *' for 8am daily) or ISO datetimes ('2026-04-01T15:00:00') for one-shots.",
        "The message is a prompt delivered to you when it fires. Write it like a user message (e.g., 'Tell the user today's weather'). Your reply is auto-routed — do NOT include delivery instructions.",
        "Do NOT reference Signal, channels, or delivery mechanisms in the message. Just describe what to do.",
      ],
      parameters: Type.Object({
        id: Type.String({ description: "Short kebab-case identifier, e.g. 'daily-weather'" }),
        schedule: Type.String({ description: "Cron expression ('0 8 * * *') or ISO datetime ('2026-04-01T15:00:00')" }),
        message: Type.String({ description: "Prompt delivered to you when this fires. Write like a user message. Your reply is auto-routed." }),
        channel: Type.Optional(Type.String({ description: "Reply channel: 'signal' or 'cli'. Default: 'cli'." })),
        timezone: Type.Optional(Type.String({ description: "IANA timezone, e.g. 'America/New_York'. Default: system TZ." })),
      }),
      async execute(toolCallId, params: { id: string; schedule: string; message: string; channel?: string; timezone?: string }, signal, onUpdate, ctx) {
        const cronDir = cronsDir;
        if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true });

        // Infer type from schedule format
        const type = /^\d{4}-\d{2}-\d{2}T/.test(params.schedule) ? "once" : "cron";

        // Derive channel and recipient from the session's channelId
        const sessionChannel = channelId.startsWith("signal:") ? "signal" : channelId.startsWith("cli") ? "cli" : "cli";
        const channel = params.channel || sessionChannel;
        const recipient = channelId.startsWith("signal:") ? channelId.slice("signal:".length) : undefined;

        const def = {
          id: params.id,
          type,
          schedule: params.schedule,
          timezone: params.timezone,
          topic: `cron.${params.id}`,
          payload: {
            content: params.message,
            sender: "cron",
            channel,
            recipient,
          },
          enabled: true,
          lastFired: null,
        };

        // Write YAML
        const filePath = join(cronDir, `${params.id}.yaml`);
        const doc = new YAML.Document(def);
        writeFileSync(filePath, doc.toString());

        // Notify scheduler via bus
        const cmdMsgId = crypto.randomUUID();
        const cmdMsg: BusMessage = {
          id: cmdMsgId,
          correlationId: cmdMsgId,
          topic: "command.schedule",
          timestamp: Date.now(),
          payload: { action: "add", ...def },
        };
        bus.publish("command.schedule", cmdMsg);

        const typeLabel = type === "cron" ? "recurring" : "one-shot";
        return {
          content: [{ type: "text", text: `Scheduled "${params.id}" (${typeLabel}, ${params.schedule}) → ${def.topic}` }],
          details: { id: params.id, schedule: params.schedule, type },
        };
      },
    };
  }

  private createCancelScheduleTaskTool(bus: EventBus): ToolDefinition {
    const cronsDir = join(this.dataDir, "crons");

    return {
      name: "cancel_schedule_task",
      label: "Cancel Scheduled Task",
      description: "Cancel a previously scheduled task by its id.",
      promptSnippet: "Cancel a scheduled task",
      promptGuidelines: [
        "Use cancel_schedule_task when the user asks to cancel, remove, or stop a scheduled task.",
        "The id must match the one used when scheduling.",
      ],
      parameters: Type.Object({
        id: Type.String({ description: "The id of the scheduled task to cancel" }),
      }),
      async execute(toolCallId, params: { id: string }, signal, onUpdate, ctx) {
        const filePath = join(cronsDir, `${params.id}.yaml`);

        // Remove via bus command
        const cancelId = crypto.randomUUID();
        const cmdMsg: BusMessage = {
          id: cancelId,
          correlationId: cancelId,
          topic: "command.schedule",
          timestamp: Date.now(),
          payload: { action: "remove", id: params.id },
        };
        bus.publish("command.schedule", cmdMsg);

        const existed = !existsSync(filePath);
        return {
          content: [{ type: "text", text: existed ? `Cancelled "${params.id}"` : `Schedule "${params.id}" not found (may have already fired)` }],
          details: { id: params.id, removed: existed },
        };
      },
    };
  }

  private async createSession(channelId: string, continueRecent: boolean): Promise<SessionInfo> {
    const safeChannelId = channelId.replace(/[^a-zA-Z0-9_\-+]/g, "_");
    const channelDir = join(this.sessionsDir, safeChannelId);
    if (!existsSync(channelDir)) {
      mkdirSync(channelDir, { recursive: true });
    }

    const loader = new DefaultResourceLoader({
      agentsFilesOverride: (current) => ({
        agentsFiles: [
          ...current.agentsFiles,
          { path: "virtual:agent-instructions", content: AGENT_INSTRUCTIONS },
        ],
      }),
    });
    await loader.reload();

    const customTools = this.bus
      ? [this.createScheduleTaskTool(this.bus, channelId), this.createCancelScheduleTaskTool(this.bus)]
      : [];

    const sessionManager = continueRecent
      ? SessionManager.continueRecent(this.workspaceDir, channelDir)
      : SessionManager.create(this.workspaceDir, channelDir);

    const { session } = await createAgentSession({
      cwd: this.workspaceDir,
      tools: createCodingTools(this.workspaceDir),
      customTools,
      sessionManager,
      modelRegistry: this.modelRegistry ?? undefined,
      authStorage: this.authStorage ?? undefined,
      resourceLoader: loader,
    });

    const info = { session, manager: session.sessionManager };
    this.sessions.set(channelId, info);
    debug("Session for", channelId, "->", channelDir, continueRecent ? "(continued)" : "(fresh)");
    return info;
  }

  private async getSession(channelId: string): Promise<SessionInfo> {
    if (!this.sessions.has(channelId)) {
      return this.createSession(channelId, true);
    }
    return this.sessions.get(channelId)!;
  }

  private async resetSession(channelId: string): Promise<void> {
    this.messageQueues.delete(channelId);
    await this.createSession(channelId, false);
  }

  private async handleInbound(bus: EventBus, msg: BusMessage): Promise<void> {
    const sender = (msg.payload as { sender?: string })?.sender;
    const content = (msg.payload as { content?: string })?.content;

    if (!sender || !content) return;

    if (content === "/new") {
      await this.resetSession(`signal:${sender}`);
      const replyTopic = msg.reply?.topic ?? msg.topic.replace("inbound", "outbound");
      const reply: BusMessage = {
        id: crypto.randomUUID(),
        correlationId: msg.correlationId,
        topic: replyTopic,
        timestamp: Date.now(),
        payload: { content: "Session reset. How can I help you?" },
      };
      bus.publish(reply.topic, reply);
      return;
    }

    debug("Processing from", sender, content);

    const response = await this.runAgent(`signal:${sender}`, content);

    if (!response) return;

    const replyTopic = msg.reply?.topic ?? msg.topic.replace("inbound", "outbound");
    const reply: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: { content: response },
    };

    debug("Replying to", sender);
    bus.publish(reply.topic, reply);
  }

  private async handleCron(bus: EventBus, msg: BusMessage): Promise<void> {
    const payload = msg.payload as {
      content?: string;
      sender?: string;
      channel?: string;
      recipient?: string;
      [key: string]: unknown;
    };

    const content = payload?.content;
    if (!content) return;

    const channel = payload.channel || "cli";
    const recipient = payload.recipient;
    const cronId = msg.topic.replace("cron.", "");
    const channelId = `cron:${cronId}`;

    debug("Processing cron:", cronId, "→", channel, recipient ? `(recipient: ${recipient})` : "");

    const response = await this.runAgent(channelId, content);
    if (!response) return;

    // Route reply based on channel — use recipient number for Signal, not "cron"
    const replyTopic = channel === "signal" && recipient
      ? `message.outbound.signal.${recipient}`
      : channel === "signal"
        ? `message.outbound.signal.cron`
        : `message.outbound.${channel}`;

    const reply: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: { content: response },
    };

    debug("Cron reply →", replyTopic);
    bus.publish(reply.topic, reply);
  }

  private async handleCommand(bus: EventBus, msg: BusMessage): Promise<void> {
    const action = (msg.payload as { action?: string })?.action;

    if (action === "reset") {
      const channel = (msg.payload as { channel?: string })?.channel;
      if (channel) {
        await this.resetSession(channel);
        console.log(`[Agent] Session reset for ${channel}`);
      }
    }
  }

  private async runAgent(channelId: string, userMessage: string): Promise<string | null> {
    const prev = this.messageQueues.get(channelId) ?? Promise.resolve();
    let resolve!: (v: string | null) => void;
    const next = prev.then(() => this.doRunAgent(channelId, userMessage)).then(
      (v) => { resolve(v); },
      () => { resolve(null); }
    );
    this.messageQueues.set(channelId, next);
    return new Promise<string | null>((r) => { resolve = r; });
  }

  private async doRunAgent(channelId: string, userMessage: string): Promise<string | null> {
    const { session } = await this.getSession(channelId);

    let responseText = "";

    return new Promise<string | null>((resolve) => {
      const unsubscribe =       session.subscribe((event) => {
        switch (event.type) {
          case "message_update":
            if (event.assistantMessageEvent.type === "text_delta") {
              responseText += event.assistantMessageEvent.delta;
            }
            break;
          case "tool_execution_start":
            debug("Tool call:", event.toolName, JSON.stringify(event.args));
            break;
          case "tool_execution_end":
            debug("Tool result:", event.toolName, event.isError ? "error" : "success");
            break;
          case "agent_end":
            unsubscribe();
            debug("Response:", responseText.slice(0, 200));
            resolve(responseText || null);
            break;
        }
      });

      session.prompt(userMessage).catch((e) => {
        unsubscribe();
        debug("Prompt error:", e);
        resolve(null);
      });
    });
  }
}
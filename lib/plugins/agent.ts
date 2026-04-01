import {
  createAgentSession,
  SessionManager,
  ModelRegistry,
  AuthStorage,
  createCodingTools,
} from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Plugin, EventBus, BusMessage } from "../types";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

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
  private modelRegistry: ModelRegistry | null = null;
  private authStorage: AuthStorage | null = null;
  private sessionsDir = resolve(process.cwd(), "data", "sessions");

  install(bus: EventBus): void {
    this.bus = bus;

    // Ensure sessions directory exists
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

    bus.subscribe("command.#", this.name, (msg: BusMessage) => {
      this.handleCommand(bus, msg);
    });
  }

  uninstall(): void {}

  private async getSession(channelId: string): Promise<SessionInfo> {
    if (!this.sessions.has(channelId)) {
      const cwd = process.cwd();
      const tools = createCodingTools(cwd);

      // Per-channel session directory (sanitize channelId for filesystem)
      const safeChannelId = channelId.replace(/[^a-zA-Z0-9_\-+]/g, "_");
      const channelDir = join(this.sessionsDir, safeChannelId);
      if (!existsSync(channelDir)) {
        mkdirSync(channelDir, { recursive: true });
      }

      // Continue recent session if exists, otherwise create new
      const { session } = await createAgentSession({
        tools,
        sessionManager: SessionManager.continueRecent(cwd, channelDir),
        modelRegistry: this.modelRegistry ?? undefined,
        authStorage: this.authStorage ?? undefined,
      });

      this.sessions.set(channelId, { session, manager: session.sessionManager });
      debug("Session for", channelId, "->", channelDir);
    }
    return this.sessions.get(channelId)!;
  }

  private resetSession(channelId: string): void {
    this.sessions.delete(channelId);
  }

  private async handleInbound(bus: EventBus, msg: BusMessage): Promise<void> {
    const sender = (msg.payload as { sender?: string })?.sender;
    const content = msg.reply || (msg.payload as { content?: string })?.content;

    if (!sender || !content) return;

    if (content === "/new") {
      this.resetSession(`signal:${sender}`);
      const replyTopic = msg.topic.replace("inbound", "outbound");
      const reply: BusMessage = {
        id: msg.id,
        topic: replyTopic,
        timestamp: Date.now(),
        payload: { content: "Session reset. How can I help you?" },
        reply: "Session reset. How can I help you?",
      };
      bus.publish(reply.topic, reply);
      return;
    }

    debug("Processing from", sender, content);

    const response = await this.runAgent(`signal:${sender}`, content);

    if (!response) return;

    const replyTopic = msg.topic.replace("inbound", "outbound");
    const reply: BusMessage = {
      id: msg.id,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: { content: response },
      reply: response,
    };

    debug("Replying to", sender);
    bus.publish(reply.topic, reply);
  }

  private handleCommand(bus: EventBus, msg: BusMessage): void {
    const action = (msg.payload as { action?: string })?.action;

    if (action === "reset") {
      const channel = (msg.payload as { channel?: string })?.channel;
      if (channel) {
        this.resetSession(channel);
        console.log(`[Agent] Session reset for ${channel}`);
      }
    }
  }

  private async runAgent(channelId: string, userMessage: string): Promise<string | null> {
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
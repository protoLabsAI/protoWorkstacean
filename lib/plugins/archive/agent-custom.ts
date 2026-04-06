import OpenAI from "openai";
import { spawn } from "bun";
import { readFile, writeFile } from "node:fs/promises";
import type { Plugin, EventBus, BusMessage } from "../../types";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  reasoning_content?: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const BASE_URL = process.env.OPENAI_BASE_URL || "http://localhost:8080/v1";
const API_KEY = process.env.OPENAI_API_KEY || "sk-dummy";

const openai = new OpenAI({
  baseURL: BASE_URL,
  apiKey: API_KEY,
});

const tools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a bash command and return the output",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a file from the filesystem",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to write to" },
          content: { type: "string", description: "The content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
];

async function executeTool(toolCall: ToolCall): Promise<string> {
  const args = toolCall.arguments as { command?: string; path?: string; content?: string };

  switch (toolCall.name) {
    case "bash": {
      const proc = spawn({
        cmd: ["bash", "-c", args.command!],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([proc.stdout?.text(), proc.stderr?.text()]);
      return stdout + stderr;
    }
    case "read": {
      try {
        const content = await readFile(args.path!, "utf-8");
        return content;
      } catch (e) {
        return `Error reading file: ${e}`;
      }
    }
    case "write": {
      try {
        await writeFile(args.path!, args.content!);
        return `File written to ${args.path}`;
      } catch (e) {
        return `Error writing file: ${e}`;
      }
    }
    default:
      return `Unknown tool: ${toolCall.name}`;
  }
}

export class AgentPlugin implements Plugin {
  name = "agent";
  description = "LLM agent - processes inbound messages and replies";
  capabilities: string[] = ["reason", "execute", "reply"];

  private bus: EventBus | null = null;
  private sessions = new Map<string, Message[]>();

  install(bus: EventBus): void {
    this.bus = bus;
    
    bus.subscribe("message.inbound.#", this.name, (msg: BusMessage) => {
      this.handleInbound(bus, msg);
    });

    bus.subscribe("command.#", this.name, (msg: BusMessage) => {
      this.handleCommand(bus, msg);
    });
  }

  uninstall(): void {}

  private getSession(channelId: string): Message[] {
    if (!this.sessions.has(channelId)) {
      this.sessions.set(channelId, []);
    }
    return this.sessions.get(channelId)!;
  }

  private resetSession(channelId: string): void {
    this.sessions.set(channelId, []);
  }

  private async handleInbound(bus: EventBus, msg: BusMessage): Promise<void> {
    const sender = (msg.payload as { sender?: string })?.sender;
    const content = (msg.payload as { content?: string })?.content;

    if (!sender || !content) return;

    // /new resets session
    if (content === "/new") {
      this.resetSession(`signal:${sender}`);
      const replyTopic = msg.reply?.topic ?? msg.topic.replace("inbound", "outbound");
      const reply: BusMessage = {
        id: msg.id,
        correlationId: msg.correlationId,
        topic: replyTopic,
        timestamp: Date.now(),
        payload: { content: "Session reset. How can I help you?" },
      };
      bus.publish(reply.topic, reply);
      return;
    }

    console.log(`[Agent] Processing from ${sender}: ${content}`);
    debug("Message:", msg);

    const response = await this.runAgent(`signal:${sender}`, content);

    if (!response) return;

    const replyTopic = msg.reply?.topic ?? msg.topic.replace("inbound", "outbound");
    const reply: BusMessage = {
      id: msg.id,
      correlationId: msg.correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: { content: response },
    };

    console.log(`[Agent] Replying to ${sender}: ${response}`);
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
    const messages = this.getSession(channelId);
    messages.push({ role: "user", content: userMessage });

    const model = "default";

    while (true) {
      const chatMessages = [...messages];

      const payload: OpenAI.Chat.ChatCompletionCreateParams = {
        model,
        messages: chatMessages,
        stream: false,
        tools: tools,
      };

      const completion = await openai.chat.completions.create(payload);

      const msg = completion.choices[0]?.message;
      if (!msg) {
        return "No response";
      }

      const assistantMessage: Message = {
        role: "assistant",
        content: msg.content || "",
      };

      // @ts-ignore - reasoning_content is not in the official types but supported by llama.cpp
      if ((msg as Record<string, unknown>).reasoning_content) {
        // @ts-ignore
        assistantMessage.reasoning_content = msg.reasoning_content;
        debug("Thinking:", assistantMessage.reasoning_content);
      }

      messages.push(assistantMessage);

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const toolArgs = typeof tc.function.arguments === "string" 
            ? JSON.parse(tc.function.arguments) 
            : tc.function.arguments;
          
          debug("Tool call:", tc.function.name, JSON.stringify(toolArgs));

          const result = await executeTool({
            id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
            name: tc.function.name,
            arguments: toolArgs,
          });

          debug("Tool result:", tc.function.name, result.slice(0, 200) + (result.length > 200 ? "..." : ""));

          messages.push({
            role: "user",
            content: `Tool ${tc.function.name} returned: ${result}`,
          });
        }

        // Continue the loop to process tool results
        continue;
      }

      // No more tool calls, return the final response
      debug("Final response:", assistantMessage.content);
      return assistantMessage.content;
    }
  }
}
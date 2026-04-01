import * as readline from "node:readline";
import { Readable } from "node:stream";
import OpenAI from "openai";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "bun";

const BASE_URL = process.env.OPENAI_BASE_URL || "http://localhost:8080/v1";
const API_KEY = process.env.OPENAI_API_KEY || "sk-dummy";

const SIGNAL_URL = process.env.SIGNAL_URL;
const SIGNAL_NUMBER = process.env.SIGNAL_NUMBER;

const openai = new OpenAI({
  baseURL: BASE_URL,
  apiKey: API_KEY,
});

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

interface Request {
  messages: Message[];
  model?: string;
  thinking?: { enabled: boolean };
  tools?: ToolDefinition[];
}

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface Response {
  message: {
    role: "assistant";
    content: string;
    reasoning_content?: string;
  };
  done: boolean;
}

interface SignalEnvelope {
  envelope: {
    source: string;
    dataMessage?: {
      message?: string;
      voiceNote?: unknown;
    };
  };
}

type ChannelHandler = (response: string) => void;

const sessions = new Map<string, Message[]>();

function getSession(channelId: string): Message[] {
  if (!sessions.has(channelId)) {
    sessions.set(channelId, []);
  }
  return sessions.get(channelId)!;
}

function resetSession(channelId: string) {
  sessions.set(channelId, []);
}

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

function formatOutput(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function printResponse(response: Response) {
  if (response.message.reasoning_content) {
    console.log(`[thinking] ${response.message.reasoning_content}`);
  }
  if (response.message.content) {
    console.log(response.message.content);
  }
}

function parseInput(input: string): Request {
  const trimmed = input.trim();
  if (!trimmed) {
    return { messages: [] };
  }
  
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && parsed.messages) {
      return parsed as Request;
    }
  } catch {
    // Not JSON, treat as plain text
  }
  
  return { messages: [{ role: "user", content: trimmed }] };
}

async function runAgent(channelId: string, newMessages: Message[], thinkingEnabled = false) {
  const messages = getSession(channelId);
  messages.push(...newMessages);

  const model = "default";

  while (true) {
    const chatMessages = [...messages];

    const payload: OpenAI.Chat.ChatCompletionCreateParams = {
      model,
      messages: chatMessages,
      stream: false,
    };

    if (thinkingEnabled) {
      // @ts-ignore - thinking is not in the official types but supported by llama.cpp
      payload.thinking = { enabled: true };
    }

    if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === "user") {
      payload.tools = tools;
    }

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
    }

    messages.push(assistantMessage);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        const result = await executeTool({
          id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
          name: tc.function.name,
          arguments: typeof tc.function.arguments === "string" 
            ? JSON.parse(tc.function.arguments) 
            : tc.function.arguments,
        });

        messages.push({
          role: "user",
          content: `Tool ${tc.function.name} returned: ${result}`,
        });
      }

      const response: Response = {
        message: {
          role: "assistant",
          content: assistantMessage.content,
          reasoning_content: assistantMessage.reasoning_content,
        },
        done: false,
      };
      return formatOutput(response);
    }

    const response: Response = {
      message: {
        role: "assistant",
        content: assistantMessage.content,
        reasoning_content: assistantMessage.reasoning_content,
      },
      done: true,
    };
    return assistantMessage.content;
  }
}

// CLI Channel
async function* createCLIInput() {
  const rl = readline.createInterface({
    input: Readable.from(process.stdin),
    output: process.stdout,
  });

  let buffer = "";
  for await (const line of rl) {
    buffer += line + "\n";
    try {
      const parsed = parseInput(buffer);
      buffer = "";
      yield parsed;
    } catch {
      // wait for more input
    }
  }
}

async function runCLChannel() {
  const channelId = "cli";
  process.stdout.write("> ");
  
  for await (const request of createCLIInput()) {
    if (request.messages === null || (Array.isArray(request.messages) && request.messages.length === 0 && getSession(channelId).length === 0)) {
      console.log("Usage: {\"messages\": [{\"role\": \"user\", \"content\": \"your message\"}]}");
      process.stdout.write("> ");
      continue;
    }

    if (request.messages && request.messages[0]?.content === "/new") {
      resetSession(channelId);
      console.log("Session reset");
      process.stdout.write("> ");
      continue;
    }

    if (request.messages) {
      const response = await runAgent(channelId, request.messages, request.thinking?.enabled ?? false);
      console.log(response);
    }
    process.stdout.write("> ");
  }
}

// Signal Channel
function parseAuth(url: string): { baseUrl: string; auth: string } {
  const match = url.match(/^https?:\/\/(.+?)@(.+)$/);
  if (match) {
    return {
      baseUrl: `https://${match[2]}`,
      auth: match[1],
    };
  }
  return { baseUrl: url, auth: "" };
}

async function sendSignalMessage(recipient: string, message: string) {
  if (!SIGNAL_URL || !SIGNAL_NUMBER) {
    console.error("SIGNAL_URL or SIGNAL_NUMBER not configured");
    return;
  }

  const { baseUrl, auth } = parseAuth(SIGNAL_URL);
  const url = `${baseUrl}/v2/send`;
  const body = {
    message,
    number: SIGNAL_NUMBER,
    recipients: [recipient],
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) {
    headers["Authorization"] = `Basic ${btoa(auth)}`;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`Signal send failed: ${res.status} ${err}`);
    }
  } catch (e) {
    console.error(`Signal send error: ${e}`);
  }
}

async function runSignalChannel() {
  if (!SIGNAL_URL || !SIGNAL_NUMBER) {
    console.log("Signal not configured, skipping bridge");
    return;
  }

  const { baseUrl, auth } = parseAuth(SIGNAL_URL);
  const wsUrl = baseUrl.replace(/^https/, "wss") + `/v1/receive/${SIGNAL_NUMBER}`;
  const wsUrlWithAuth = auth ? wsUrl.replace(/^wss?:\/\//, `wss://${auth}@`) : wsUrl;
  console.log(`Connecting to Signal WebSocket: ${wsUrl}`);

  const ws = new WebSocket(wsUrlWithAuth);

  ws.onopen = () => console.log("Signal bridge connected");
  ws.onerror = (err) => console.error("Signal WebSocket error:", err);
  ws.onclose = () => console.log("Signal WebSocket closed");

  ws.onmessage = async (event) => {
    try {
      const data: SignalEnvelope = JSON.parse(event.data);
      const envelope = data.envelope;

      if (!envelope.dataMessage) {
        return;
      }

      // Voice notes: silently ignored for now
      // TODO: integrate whisper for voice note transcription
      if (envelope.dataMessage.voiceNote) {
        return;
      }

      const text = envelope.dataMessage.message;
      if (!text) {
        return;
      }

      const sender = envelope.source;
      const channelId = `signal:${sender}`;
      console.log(`[Signal] ${sender}: ${text}`);

      const response = await runAgent(channelId, [{ role: "user", content: text }]);
      
      console.log(`[Signal] Sending to ${sender}: ${response}`);
      await sendSignalMessage(sender, response);

    } catch (e) {
      console.error("Error processing Signal message:", e);
    }
  };
}

// Main
async function main() {
  console.log("WorkStacean starting...");

  await Promise.all([
    runCLChannel(),
    runSignalChannel(),
  ]);
}

main().catch(console.error);

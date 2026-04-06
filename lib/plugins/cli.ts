import * as readline from "node:readline";
import { Readable } from "node:stream";
import type { Plugin, EventBus, BusMessage } from "../types";

export class CLIPlugin implements Plugin {
  name = "cli";
  description = "CLI input - reads stdin and publishes commands";
  capabilities: string[] = ["input", "query"];

  private bus: EventBus | null = null;
  private rl: readline.Interface | null = null;
  private pendingChat = new Map<string, { resolve: (msg: BusMessage) => void }>();

  install(bus: EventBus): void {
    this.bus = bus;

    // Subscribe to outbound replies for chat
    bus.subscribe("message.outbound.cli", this.name, (msg: BusMessage) => {
      this.handleReply(msg);
    });

    this.rl = readline.createInterface({
      input: Readable.from(process.stdin),
      output: process.stdout,
    });

    this.rl.on("line", (line) => {
      this.handleInput(line.trim());
    });
  }

  /** Call after startup messages to show prompt */
  showPrompt(): void {
    process.stdout.write("> ");
  }

  uninstall(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  private handleReply(msg: BusMessage): void {
    // Clear thinking indicator
    process.stdout.write("\r\x1b[K");

    const content = (msg.payload as { content?: string })?.content ?? JSON.stringify(msg.payload);
    console.log(content);
    process.stdout.write("> ");
  }

  private handleInput(input: string): void {
    if (!this.bus) return;

    if (!input) {
      process.stdout.write("> ");
      return;
    }

    // Clear the echoed line from readline
    process.stdout.write("\x1b[1A\x1b[K");

    // Parse command
    const parts = input.split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case "help":
        this.showHelp();
        process.stdout.write("> ");
        break;
      case "topics":
        this.showTopics();
        process.stdout.write("> ");
        break;
      case "consumers":
        this.showConsumers();
        process.stdout.write("> ");
        break;
      case "signal":
        this.handleSignalCommand(parts.slice(1));
        process.stdout.write("> ");
        break;
      case "chat":
        this.handleChatCommand(parts.slice(1).join(" "));
        break;
      default:
        // Treat bare input as chat
        this.handleChatCommand(input);
        break;
    }
  }

  private showHelp(): void {
    console.log("\nCommands:");
    console.log("  chat hello            - Chat with agent (or just type message)");
    console.log("  signal +1234 hello    - Send message to signal number");
    console.log("  topics                - Show available topics");
    console.log("  consumers             - Show active consumers");
    console.log("  help                  - Show this help");
    console.log("  {\"topic\":\"...\",...} - Raw JSON publish");
    console.log("\nEnvironment:");
    console.log("  DEBUG=1               - Show agent thinking and tool calls\n");
  }

  private showTopics(): void {
    if (!this.bus) return;
    const topics = this.bus.topics();
    console.log("\nTopics:");
    if (topics.length === 0) {
      console.log("  (none)");
    } else {
      for (const t of topics) {
        console.log(`  ${t.pattern} (${t.subscribers} subscribers)`);
      }
    }
    console.log();
  }

  private showConsumers(): void {
    if (!this.bus) return;
    const consumers = this.bus.consumers();
    console.log("\nConsumers:");
    if (consumers.length === 0) {
      console.log("  (none)");
    } else {
      for (const c of consumers) {
        console.log(`  ${c.name}: ${c.subscriptions.join(", ")}`);
      }
    }
    console.log();
  }

  private handleSignalCommand(args: string[]): void {
    if (!this.bus) return;

    if (args.length < 2) {
      console.log("Usage: signal +1234 message text");
      return;
    }

    const number = args[0];
    const message = args.slice(1).join(" ");

    const msgId = crypto.randomUUID();
    const busMessage: BusMessage = {
      id: msgId,
      correlationId: msgId,
      topic: `message.outbound.signal.${number}`,
      timestamp: Date.now(),
      payload: { content: message },
    };

    this.bus.publish(busMessage.topic, busMessage);
    console.log(`Published to ${busMessage.topic}`);
  }

  private handleChatCommand(message: string): void {
    if (!this.bus) return;
    if (!message) {
      process.stdout.write("> ");
      return;
    }

    const id = crypto.randomUUID();
    const msg: BusMessage = {
      id,
      correlationId: id,
      topic: "message.inbound.cli",
      timestamp: Date.now(),
      payload: { sender: "cli", content: message },
      source: { interface: "api" },
      reply: { topic: "message.outbound.cli" },
    };

    // Show thinking indicator
    process.stdout.write("\x1b[90m[thinking...]\x1b[0m ");

    this.bus.publish(msg.topic, msg);
  }

  private handleRawInput(input: string): void {
    if (!this.bus) return;

    try {
      const parsed = JSON.parse(input);
      if (parsed.topic && typeof parsed.topic === "string") {
        const rawId = parsed.id || crypto.randomUUID();
        const msg: BusMessage = {
          id: rawId,
          correlationId: parsed.correlationId || rawId,
          topic: parsed.topic,
          timestamp: Date.now(),
          payload: parsed.payload ?? parsed,
          reply: typeof parsed.reply === "string"
            ? { topic: parsed.reply }
            : parsed.reply,
          replyTo: parsed.replyTo,
        };
        this.bus.publish(msg.topic, msg);
        console.log(`Published to ${msg.topic}`);
      } else {
        console.log("JSON must have a 'topic' field");
      }
    } catch {
      console.log(`Unknown command: ${input.split(/\s+/)[0]}. Type 'help' for commands.`);
    }
  }
}
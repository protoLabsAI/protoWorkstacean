import * as readline from "node:readline";
import { Readable } from "node:stream";
import type { Plugin, EventBus, BusMessage } from "../types";

export class CLIPlugin implements Plugin {
  name = "cli";
  description = "CLI input - reads stdin and publishes commands";
  capabilities: string[] = ["input", "query"];

  private bus: EventBus | null = null;
  private rl: readline.Interface | null = null;

  install(bus: EventBus): void {
    this.bus = bus;
    this.rl = readline.createInterface({
      input: Readable.from(process.stdin),
      output: process.stdout,
    });

    process.stdout.write("> ");
    
    this.rl.on("line", (line) => {
      this.handleInput(line.trim());
    });
  }

  uninstall(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  private handleInput(input: string): void {
    if (!this.bus) return;

    if (!input) {
      process.stdout.write("> ");
      return;
    }

    // Parse command
    const parts = input.split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case "help":
        this.showHelp();
        break;
      case "topics":
        this.showTopics();
        break;
      case "consumers":
        this.showConsumers();
        break;
      case "signal":
        this.handleSignalCommand(parts.slice(1));
        break;
      default:
        // Try to parse as JSON for raw publishing
        this.handleRawInput(input);
    }

    process.stdout.write("> ");
  }

  private showHelp(): void {
    console.log("\nCommands:");
    console.log("  signal +1234 hello    - Send message to signal number");
    console.log("  topics                - Show available topics");
    console.log("  consumers             - Show active consumers");
    console.log("  help                  - Show this help");
    console.log("  {\"topic\":\"...\",...} - Raw JSON publish\n");
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

    const busMessage: BusMessage = {
      id: crypto.randomUUID(),
      topic: `message.outbound.signal.${number}`,
      timestamp: Date.now(),
      payload: { content: message },
      reply: message,
    };

    this.bus.publish(busMessage.topic, busMessage);
    console.log(`Published to ${busMessage.topic}`);
  }

  private handleRawInput(input: string): void {
    if (!this.bus) return;

    try {
      const parsed = JSON.parse(input);
      if (parsed.topic && typeof parsed.topic === "string") {
        const msg: BusMessage = {
          id: parsed.id || crypto.randomUUID(),
          topic: parsed.topic,
          timestamp: Date.now(),
          payload: parsed.payload ?? parsed,
          reply: parsed.reply,
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
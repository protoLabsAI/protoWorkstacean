#!/usr/bin/env bun

// Simple test utility to publish messages to the bus
// Usage: bun run src/test-pub.ts "signal +1234 hello"
// Or: bun run src/test-pub.ts '{"topic":"message.outbound.signal.+1234","reply":"hello"}'

import { InMemoryEventBus } from "../lib/bus";
import { SignalPlugin } from "../lib/plugins/signal";
import { LoggerPlugin } from "../lib/plugins/logger";
import type { BusMessage } from "../lib/types";

const bus = new InMemoryEventBus();

// Install plugins
const logger = new LoggerPlugin();
const signal = new SignalPlugin();

logger.install(bus);
signal.install(bus);

// Get args
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log("Usage: bun run src/test-pub.ts \"signal +1234 hello\"");
  console.log("   or: bun run src/test-pub.ts '{\"topic\":\"message.outbound.signal.+1234\",\"reply\":\"hello\"}'");
  process.exit(1);
}

const input = args.join(" ");

// Parse input
if (input.startsWith("{")) {
  // JSON input
  try {
    const parsed = JSON.parse(input);
    if (parsed.topic) {
      const msg: BusMessage = {
        id: parsed.id || crypto.randomUUID(),
        topic: parsed.topic,
        timestamp: Date.now(),
        payload: parsed.payload ?? parsed,
        reply: parsed.reply,
        replyTo: parsed.replyTo,
      };
      bus.publish(msg.topic, msg);
      console.log(`Published to ${msg.topic}`);
    } else {
      console.error("JSON must have a 'topic' field");
      process.exit(1);
    }
  } catch (e) {
    console.error("Invalid JSON:", e);
    process.exit(1);
  }
} else {
  // Parse command format: "signal +1234 hello"
  const parts = input.split(/\s+/);
  if (parts[0].toLowerCase() === "signal" && parts.length >= 3) {
    const number = parts[1];
    const message = parts.slice(2).join(" ");
    
    const msg: BusMessage = {
      id: crypto.randomUUID(),
      topic: `message.outbound.signal.${number}`,
      timestamp: Date.now(),
      payload: { content: message },
      reply: message,
    };
    
    bus.publish(msg.topic, msg);
    console.log(`Published to ${msg.topic}`);
  } else {
    console.error("Usage: signal +1234 hello");
    process.exit(1);
  }
}

// Wait a moment for async operations
await new Promise(resolve => setTimeout(resolve, 1000));
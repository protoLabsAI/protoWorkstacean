import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { InMemoryEventBus } from "../lib/bus";
import { LoggerPlugin } from "../lib/plugins/logger";
import { AgentPlugin } from "../lib/plugins/agent";
import { SchedulerPlugin } from "../lib/plugins/scheduler";
import type { BusMessage } from "../lib/types";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

interface TestPrompt {
  name: string;
  message: string;
}

const TEST_PROMPTS: TestPrompt[] = [
  { name: "schedule-oneshot", message: "Schedule a one-shot task for 10 seconds from now that says 'Hello from cron!'" },
  { name: "schedule-time-check", message: "Schedule a task for 15 seconds from now: 'What time is it?'" },
];

function getIsoTimeIn(seconds: number): string {
  const date = new Date(Date.now() + seconds * 1000);
  return date.toISOString();
}

async function waitForReply(
  logger: LoggerPlugin,
  topicPattern: string,
  correlationId: string,
  timeoutMs: number = 30000
): Promise<BusMessage | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const events = logger.getEvents(1000);
    const replyEvent = events.find((e) => {
      if (correlationId && e.correlationId !== correlationId) return false;
      if (topicPattern && !e.topic.startsWith(topicPattern)) return false;
      return true;
    });
    if (replyEvent) {
      return replyEvent;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  debug(`Timeout waiting for reply matching ${topicPattern} with correlationId ${correlationId}`);
  return null;
}

async function waitForCronFire(
  logger: LoggerPlugin,
  cronTopic: string,
  timeoutMs: number = 60000
): Promise<BusMessage | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const events = logger.getEvents(1000);
    const cronEvent = events.find((e) => e.topic === cronTopic);
    if (cronEvent) {
      return cronEvent;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  debug(`Timeout waiting for cron fire on ${cronTopic}`);
  return null;
}

async function runTests(): Promise<void> {
  const timestamp = Date.now();
  const testDir = resolve(process.cwd(), `tmp/test-cron-${timestamp}`);
  const workspaceDir = join(testDir, "workspace");
  const dataDir = join(testDir, "data");

  console.log(`\n=== Cron Test Suite: ${timestamp} ===`);
  console.log(`Workspace: ${workspaceDir}`);
  console.log(`Data: ${dataDir}\n`);

  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
  }
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const bus = new InMemoryEventBus();
  const logger = new LoggerPlugin(dataDir);
  const agent = new AgentPlugin(workspaceDir, dataDir);
  const scheduler = new SchedulerPlugin(dataDir);

  logger.install(bus);
  agent.install(bus);
  scheduler.install(bus);

  debug("Agent workspace:", agent["workspaceDir"]);
  debug("Scheduler crons dir:", scheduler["cronsDir"]);

  // --- Schedule tests via agent ---
  for (const [index, test] of TEST_PROMPTS.entries()) {
    console.log(`\n--- Test ${index + 1}/${TEST_PROMPTS.length}: ${test.name} ---`);
    console.log(`Q: ${test.message}`);

    const correlationId = crypto.randomUUID();
    const message: BusMessage = {
      id: crypto.randomUUID(),
      correlationId,
      topic: "message.inbound.test",
      timestamp: Date.now(),
      payload: { sender: "test", content: test.message },
    };

    bus.publish(message.topic, message);

    const reply = await waitForReply(logger, "message.outbound.test", correlationId, 30000);

    if (reply) {
      const replyContent = (reply.payload as { content?: string })?.content ?? JSON.stringify(reply.payload);
      console.log(`Agent response: ${replyContent}`);
      console.log(`Cron YAML should be created in: ${join(workspaceDir, "crons/")}`);
    } else {
      console.log(`[TIMEOUT - no agent reply received]`);
    }

    // Wait for cron to fire (for one-shot schedules)
    console.log("\nWaiting for cron to fire...");
    await new Promise((r) => setTimeout(r, 3000)); // Give scheduler time to process

    const allEvents = logger.getEvents(1000);
    const cronEvents = allEvents.filter((e) => e.topic.startsWith("cron."));
    
    if (cronEvents.length > 0) {
      console.log(`Cron events detected: ${cronEvents.map((e) => e.topic).join(", ")}`);
      for (const cronEvent of cronEvents) {
        console.log(`  - ${cronEvent.topic}: ${(cronEvent.payload as { content?: string })?.content || JSON.stringify(cronEvent.payload)}`);
      }
    } else {
      console.log("No cron events fired yet (may still be pending)");
    }

    // Check for agent responses to cron prompts
    const outboundEvents = allEvents.filter((e) => e.topic.startsWith("message.outbound."));
    if (outboundEvents.length > 0) {
      console.log("\nOutbound agent responses:");
      for (const evt of outboundEvents) {
        const evtContent = (evt.payload as { content?: string })?.content ?? JSON.stringify(evt.payload);
        console.log(`  - ${evt.topic}: ${evtContent.slice(0, 200)}...`);
      }
    }

    // Wait for the scheduled time to pass
    if (test.name === "schedule-oneshot") {
      console.log("\nWaiting 12 seconds for one-shot cron to fire...");
      await new Promise((r) => setTimeout(r, 12000));
    } else if (test.name === "schedule-time-check") {
      console.log("\nWaiting 17 seconds for one-shot cron to fire...");
      await new Promise((r) => setTimeout(r, 17000));
    }
  }

  // --- Manual cron test ---
  console.log(`\n--- Test ${TEST_PROMPTS.length + 1}: manual-cron-fire ---`);
  console.log("Q: Manually firing a cron event to test agent handling");

  const manualCronId = crypto.randomUUID();
  const manualCronMsg: BusMessage = {
    id: manualCronId,
    correlationId: manualCronId,
    topic: "cron.manual-test",
    timestamp: Date.now(),
    payload: {
      content: "This is a manual cron test. Please respond naturally.",
      sender: "cron",
      channel: "test",
    },
  };

  bus.publish(manualCronMsg.topic, manualCronMsg);

  console.log("Waiting for agent response to manual cron...");
  const manualCronReply = await waitForReply(logger, "message.outbound.test", manualCronId, 30000);

  if (manualCronReply) {
    console.log(`Agent response: ${(manualCronReply.payload as { content?: string })?.content ?? JSON.stringify(manualCronReply.payload)}`);
  } else {
    console.log(`[TIMEOUT - no agent reply to manual cron]`);
  }

  // --- Final summary ---
  const allEvents = logger.getEvents(1000);
  console.log(`\n=== Cron Test Suite Complete ===`);
  console.log(`Total events logged: ${allEvents.length}`);
  console.log(`Events logged to: ${join(dataDir, "events.db")}`);
  console.log(`Cron files in: ${join(workspaceDir, "crons/")}`);

  // List cron files
  const cronsDir = join(workspaceDir, "crons");
  if (existsSync(cronsDir)) {
    const cronFiles = readdirSync(cronsDir);
    if (cronFiles.length > 0) {
      console.log(`\nRemaining cron files:`);
      for (const file of cronFiles) {
        console.log(`  - ${file}`);
      }
    } else {
      console.log("\nNo remaining cron files (all one-shots fired)");
    }
  }
}

runTests().catch((err) => {
  console.error("Test suite error:", err);
  process.exit(1);
});

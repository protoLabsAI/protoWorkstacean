import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { InMemoryEventBus } from "../lib/bus";
import { LoggerPlugin } from "../lib/plugins/logger";
import { AgentPlugin } from "../lib/plugins/agent";
import type { BusMessage } from "../lib/types";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

async function waitForReply(
  logger: LoggerPlugin,
  topic: string,
  correlationId: string,
  timeoutMs: number = 30000
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const events = logger.getEventsByTopic(topic);
    const replyEvent = events.find((e) => e.correlationId === correlationId);
    if (replyEvent) {
      return (replyEvent.payload as { content?: string })?.content ?? JSON.stringify(replyEvent.payload);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  debug(`Timeout waiting for reply on ${topic} with correlationId ${correlationId}`);
  return null;
}

function listSessionFiles(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const stat = statSync(join(sessionsDir, f));
      return { name: f, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .map((f) => `${f.name} (${(f.size / 1024).toFixed(1)}KB, modified ${f.mtime.toISOString()})`);
}

async function sendAndWait(
  bus: InMemoryEventBus,
  logger: LoggerPlugin,
  sender: string,
  content: string,
  timeoutMs?: number
): Promise<string | null> {
  const correlationId = crypto.randomUUID();
  const message: BusMessage = {
    id: crypto.randomUUID(),
    correlationId,
    topic: "message.inbound.test",
    timestamp: Date.now(),
    payload: { sender, content },
  };

  bus.publish(message.topic, message);

  return waitForReply(logger, "message.outbound.test", correlationId, timeoutMs);
}

async function runTests(): Promise<void> {
  const timestamp = Date.now();
  const testDir = resolve(process.cwd(), `tmp/test-session-${timestamp}`);
  const workspaceDir = join(testDir, "workspace");
  const dataDir = join(testDir, "data");
  const sessionsDir = join(dataDir, "sessions", "signal_test");

  console.log(`\n=== Session Persistence Test: ${timestamp} ===`);
  console.log(`Workspace: ${workspaceDir}`);
  console.log(`Data: ${dataDir}\n`);

  if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true });
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  let reply: string | null;

  // =========================================================================
  // Test 1: First session - establish a conversation fact naturally
  // No "remember" instruction - just state it as part of conversation
  // =========================================================================
  console.log("--- Test 1: first-session ---");
  console.log("Q: I'm planning a trip to Reykjavik next month.\n");

  let bus = new InMemoryEventBus();
  let logger = new LoggerPlugin(dataDir);
  let agent = new AgentPlugin(workspaceDir, dataDir);

  logger.install(bus);
  agent.install(bus);

  reply = await sendAndWait(bus, logger, "test", "I'm planning a trip to Reykjavik next month.", 60000);
  console.log(`A: ${reply ?? "[TIMEOUT]"}\n`);

  // =========================================================================
  // Test 2: Simulate container restart - new AgentPlugin instance
  // If continueRecent() works, the JSONL history contains the Reykjavik mention
  // =========================================================================
  console.log("--- Test 2: simulate-restart ---");
  console.log("(Creating new AgentPlugin instance - simulates container restart)\n");
  console.log("Q: Where am I planning to travel?\n");

  agent.uninstall();
  logger.uninstall();

  bus = new InMemoryEventBus();
  logger = new LoggerPlugin(dataDir);
  agent = new AgentPlugin(workspaceDir, dataDir);

  logger.install(bus);
  agent.install(bus);

  reply = await sendAndWait(bus, logger, "test", "Where am I planning to travel?", 60000);
  console.log(`A: ${reply ?? "[TIMEOUT]"}\n`);

  if (reply?.toLowerCase().includes("reykjavik")) {
    console.log("✅ PASS: Agent recalled from JSONL session history\n");
  } else {
    console.log("❌ FAIL: Agent did not recall - session not continued from JSONL\n");
  }

  // =========================================================================
  // Test 3: Send /new command - should reset session
  // =========================================================================
  console.log("--- Test 3: /new-command ---");
  console.log("Q: /new\n");

  reply = await sendAndWait(bus, logger, "test", "/new");
  console.log(`A: ${reply ?? "[TIMEOUT]"}\n`);

  if (reply?.toLowerCase().includes("reset")) {
    console.log("✅ PASS: Session reset confirmed\n");
  } else {
    console.log("⚠️  WARNING: Unexpected response to /new\n");
  }

  // =========================================================================
  // Test 4: Post-reset - agent should NOT know about Reykjavik
  // =========================================================================
  console.log("--- Test 4: post-reset-no-memory ---");
  console.log("Q: Where am I planning to travel?\n");

  reply = await sendAndWait(bus, logger, "test", "Where am I planning to travel?", 60000);
  console.log(`A: ${reply ?? "[TIMEOUT]"}\n`);

  if (reply?.toLowerCase().includes("reykjavik")) {
    console.log("❌ FAIL: Agent still knows about Reykjavik - session not reset\n");
  } else {
    console.log("✅ PASS: Agent does not know - fresh session confirmed\n");
  }

  // =========================================================================
  // Summary: List session files
  // =========================================================================
  console.log("=== Session Files ===");
  const files = listSessionFiles(sessionsDir);
  if (files.length === 0) {
    console.log("No session files found\n");
  } else {
    for (const f of files) {
      console.log(`  ${f}`);
    }
    console.log("");
  }

  if (files.length >= 2) {
    console.log("✅ Both pre-/new and post-/new session files exist\n");
  } else if (files.length === 1) {
    console.log("⚠️  Only one session file found\n");
  }

  console.log("=== Test Suite Complete ===");
  console.log(`Events logged to: ${join(dataDir, "events.db")}`);
  console.log(`Session files in: ${sessionsDir}\n`);
}

runTests().catch((err) => {
  console.error("Test suite error:", err);
  process.exit(1);
});

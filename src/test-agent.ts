import { existsSync, mkdirSync } from "node:fs";
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

interface TestPrompt {
  name: string;
  message: string;
}

const TEST_PROMPTS: TestPrompt[] = [
  { name: "pwd", message: "Run `pwd` and tell me the output" },
  { name: "ls", message: "Run `ls -la` and tell me what you see" },
  { name: "write-file", message: "Write a file called `test-hello.txt` with 'hello from agent' to the workspace root" },
  { name: "read-file", message: "Read the file `test-hello.txt`" },
];

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

async function runTests(): Promise<void> {
  const timestamp = Date.now();
  const testDir = resolve(process.cwd(), `tmp/test-${timestamp}`);
  const workspaceDir = join(testDir, "workspace");
  const dataDir = join(testDir, "data");

  console.log(`\n=== Test Suite: ${timestamp} ===`);
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

  logger.install(bus);
  agent.install(bus);

  debug("Agent workspace:", agent["workspaceDir"]);

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

    const reply = await waitForReply(logger, "message.outbound.test", correlationId);

    if (reply) {
      console.log(`A: ${reply}`);
    } else {
      console.log(`A: [TIMEOUT - no reply received]`);
    }
  }

  console.log(`\n=== Test Suite Complete ===`);
  console.log(`Events logged to: ${join(dataDir, "events.db")}`);
}

runTests().catch((err) => {
  console.error("Test suite error:", err);
  process.exit(1);
});

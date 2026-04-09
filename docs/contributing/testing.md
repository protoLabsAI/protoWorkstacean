---
title: Testing Methodology
---

# Testing Methodology

This document describes the testing approach for WorkStacean's agent and cron functionality using sequential, observational test scripts.

## Overview

WorkStacean uses **standalone test scripts** that wire up real plugins (agent, scheduler, logger) with an in-memory event bus. Tests run sequentially, publishing messages and polling SQLite for responses. Results are logged to stdout for human inspection rather than automated assertions.

### Why This Approach

- **Real LLM interactions**: Tests use the actual Pi SDK with real model calls, catching issues that mocks would miss
- **Sequential execution**: Each test waits for completion before proceeding, making it easy to trace causality
- **SQLite polling**: Leverages the existing LoggerPlugin to capture all bus events without custom pub/sub consumers
- **Observational output**: Logs questions, responses, and timing to stdout for manual judgment
- **Persistent traces**: Events are saved to SQLite for post-mortem analysis

## Test Scripts

### `src/test-agent.ts` - Agent Workspace Tests

Tests that the Pi SDK agent operates within the configured workspace directory, not `process.cwd()`.

**What it tests:**
1. `pwd` command returns workspace dir (not `/usr/src/app`)
2. `ls -la` shows workspace contents
3. File write operations go to workspace root
4. File read operations work from workspace

**How to run:**
```bash
bun run src/test-agent.ts
```

**With debug output:**
```bash
DEBUG=1 bun run src/test-agent.ts
```

**Expected behavior:**
- `pwd` should return the test workspace path (e.g., `/home/.../tmp/test-*/workspace`)
- Files written by the agent should appear in the workspace dir, not the project root
- All tool calls (bash, read, write, edit) are constrained to workspace

**Common issues:**
- If `pwd` returns `/usr/src/app` or the project root, the agent's `createAgentSession` is missing the `cwd` parameter
- If files appear outside the workspace, `createCodingTools` isn't being passed the workspace dir

### `src/test-cron.ts` - Cron/Scheduler Tests

Tests the full cron pipeline: agent scheduling → scheduler persistence → cron firing → agent response.

**What it tests:**
1. Agent schedules one-shot tasks via `schedule_task` tool
2. Scheduler creates YAML files in `data/crons/`
3. Missed schedules fire immediately (delay < 0)
4. Agent receives cron prompts and responds naturally
5. Manual cron events are processed correctly

**How to run:**
```bash
bun run src/test-cron.ts
```

**With debug output:**
```bash
DEBUG=1 bun run src-cron.ts
```

**Test flow:**
1. Agent schedules task for N seconds from now
2. Test waits for agent confirmation (schedule_task tool call)
3. Scheduler fires missed schedule immediately (timestamp already in past)
4. Agent receives cron prompt, responds naturally
5. Test logs full event chain to stdout and SQLite

**Expected behavior:**
- `schedule_task` tool is called with correct parameters (id, schedule, message)
- Cron YAML files are created in `data/crons/`
- One-shot schedules fire immediately if timestamp is in the past
- Agent responds to cron prompts without trying to "send messages" itself
- Manual `cron.*` events trigger agent responses

**Common issues:**
- Routing bugs: Check that `channel` and `recipient` in cron payloads match expected output topics
- Timing issues: One-shot schedules may fire immediately if the scheduled time is already past

## Architecture

### Test Script Pattern

```typescript
// 1. Create temp directories
const testDir = resolve(process.cwd(), `tmp/test-${timestamp}`);
const workspaceDir = join(testDir, "workspace");
const dataDir = join(testDir, "data");

// 2. Wire up plugins
const bus = new InMemoryEventBus();
const logger = new LoggerPlugin(dataDir);
const router = new RouterPlugin(workspaceDir);
const dispatcher = new SkillDispatcherPlugin();
const scheduler = new SchedulerPlugin(dataDir);

logger.install(bus);
router.install(bus);
dispatcher.install(bus);
scheduler.install(bus);

// 3. Publish test message
bus.publish("message.inbound.test", {
  topic: "message.inbound.test",
  payload: { sender: "test", content: "..." },
});

// 4. Poll SQLite for response
const reply = await waitForReply(logger, "message.outbound.test", correlationId);

// 5. Log results
console.log(`Q: ${question}`);
console.log(`A: ${reply.reply}`);
```

### Polling Helper

```typescript
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
    if (replyEvent) return replyEvent;
    await new Promise((r) => setTimeout(r, 100));
  }
  
  return null;
}
```

## Inspecting Results

### View SQLite events

```bash
# Install sqlite3 if needed
sqlite3 tmp/test-*/data/events.db "SELECT topic, reply FROM events ORDER BY timestamp;"
```

### Check workspace files

```bash
ls -la tmp/test-*/workspace/
cat tmp/test-*/data/crons/*.yaml
```

### Debug output

Set `DEBUG=1` to see:
- Tool calls with parameters
- Session creation details
- Cron scheduling and firing
- Agent response streaming

## Adding New Tests

1. Add test prompt to `TEST_PROMPTS` array
2. Add wait time if testing delayed cron execution
3. Add custom polling if checking specific event patterns
4. Run and inspect output

Example:
```typescript
const TEST_PROMPTS: TestPrompt[] = [
  // ... existing tests
  { name: "my-test", message: "Test instruction here" },
];
```

## Environment Variables

- `DEBUG=1` - Enable verbose logging (tool calls, session details, etc.)
- `OPENAI_API_KEY` - Required for real LLM calls
- `TZ` - Timezone for cron scheduling (default: system timezone)

## Limitations

- **No automated assertions**: Tests rely on human judgment of output
- **Sequential only**: Parallel tests would require more complex coordination
- **Real LLM costs**: Each test run incurs API calls to the model
- **Timing sensitivity**: Cron tests depend on wall clock time for one-shot schedules

## Future Improvements

- Add optional assertion mode for CI/CD
- Support mock LLM responses for faster iteration
- Add parallel test execution with isolated buses
- Generate test reports from SQLite event traces

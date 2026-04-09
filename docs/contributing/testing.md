---
title: Testing
---

## Unit tests (current pattern)

protoWorkstacean uses [Bun's built-in test runner](https://bun.sh/docs/cli/test). Tests live alongside source files and use the in-memory event bus directly — no LLM calls, no network.

```bash
bun test
```

### Writing a test

Wire up the plugins you need against `InMemoryEventBus`, publish a message, and assert on what comes back.

```typescript
import { describe, it, expect } from 'bun:test';
import { InMemoryEventBus } from '../lib/bus/in-memory-event-bus';
import { SchedulerPlugin } from '../lib/plugins/scheduler';

describe('SchedulerPlugin', () => {
  it('fires a missed one-shot schedule immediately', async () => {
    const bus = new InMemoryEventBus();
    const scheduler = new SchedulerPlugin('/tmp/test-data');
    await scheduler.install(bus);

    const received: unknown[] = [];
    bus.subscribe('cron.test-job', (msg) => received.push(msg));

    // ... publish schedule event, await tick
    expect(received).toHaveLength(1);
  });
});
```

See `lib/plugins/scheduler.test.ts` for a full working example.

---

## Legacy observational scripts

`src/test-agent.ts` and `src/test-cron.ts` are **not tests of the current production runtime**. They were written to exercise the Pi SDK agent (`@mariozechner/pi-coding-agent`) and are observational — they make real LLM calls and log output to stdout for human inspection. No automated assertions.

These scripts are kept for reference but do **not** represent the current testing approach. The production runtime is `ProtoSdkExecutor` (`@protolabsai/sdk`), which has no equivalent observational scripts yet.

If you want to run them anyway:

```bash
# Requires OPENAI_API_KEY
bun run src/test-agent.ts
bun run src/test-cron.ts
```

---

## CI

The CI pipeline runs `bun test` and `bun run tsc --noEmit` on every push/PR. See `.github/workflows/build.yml`.

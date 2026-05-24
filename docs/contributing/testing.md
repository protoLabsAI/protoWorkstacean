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

## CI

The CI pipeline runs `bun test` and `bun run tsc --noEmit` on every push/PR. See `.github/workflows/build.yml`.

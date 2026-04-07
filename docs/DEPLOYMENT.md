# Deployment Guide — Budget System

## Prerequisites

- Bun ≥ 1.0
- SQLite (bundled with Bun)
- Discord webhook URLs (optional, for alerts)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BUDGET_WEBHOOK_URL` | No | Discord webhook for budget threshold alerts |
| `DISCORD_OPS_WEBHOOK_URL` | No | Fallback ops channel webhook |
| `DATA_DIR` | Yes | Directory for SQLite databases (e.g. `./data`) |

## Installing the BudgetPlugin

In your application entry point (`src/index.ts`), register the plugin:

```typescript
import { BudgetPlugin } from "../lib/plugins/budget.ts";

const budgetPlugin = new BudgetPlugin(dataDir);
bus.install(budgetPlugin);
```

Or with the existing plugin loader pattern:

```typescript
const plugins = [
  new LoggerPlugin(dataDir),
  new HITLPlugin(workspaceDir),
  new BudgetPlugin(dataDir),
  // ...
];
```

## Database

The BudgetPlugin creates `budget.db` in the configured `dataDir`:

```
data/
├── budget.db       ← budget ledger (SQLite)
├── events.db       ← event log (LoggerPlugin)
└── sessions/       ← agent sessions
```

The schema is auto-migrated on startup. No manual migration steps are needed.

## Verifying Deployment

After startup, send a test budget request on the bus:

```typescript
bus.publish("budget.request.test", {
  id: crypto.randomUUID(),
  correlationId: "test-1",
  topic: "budget.request.test",
  timestamp: Date.now(),
  payload: {
    type: "budget_request",
    requestId: "test-1",
    agentId: "ava",
    projectId: "test-project",
    promptText: "Hello world",
  },
});
```

You should see a `budget.decision.test-1` response on the bus.

## Rollback

The BudgetPlugin is additive — removing it from the plugin list will stop
budget enforcement without affecting other plugins. No data migration is needed.

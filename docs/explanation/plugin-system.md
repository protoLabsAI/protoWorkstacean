# Plugin System

## The plugin interface

Every plugin in protoWorkstacean implements:

```typescript
interface Plugin {
  readonly name: string;
  readonly description: string;
  readonly capabilities: string[];

  install(bus: EventBus): void;
  uninstall(): void;
}
```

`install(bus)` is called once at startup, in order. The plugin subscribes to topics, registers resources (executors, tools), and stores any references it needs. `uninstall()` is called during graceful shutdown — it should cancel subscriptions and release resources.

This is the entire contract. A plugin knows about the bus and nothing else. It doesn't hold references to other plugins. It doesn't know what order it was loaded in (except for the guarantees described below).

## Why no inter-plugin references

Direct plugin-to-plugin calls create invisible dependencies. If `CeremonyPlugin` calls `SkillDispatcherPlugin.dispatch()` directly, then CeremonyPlugin can't be tested in isolation, can't be replaced, and CeremonyPlugin must be loaded after SkillDispatcherPlugin. These dependencies compound.

The bus forces all communication through a single, inspectable channel. The consequence is:
- Every plugin interaction is observable (it's in the event log)
- Plugins are individually testable (inject a mock bus)
- Load order within a tier is irrelevant to correctness

The cost is one extra message hop for interactions between plugins. In practice, this is never measurable — the bus is in-memory and messages are processed synchronously within the same process.

## Plugin categories

### Core plugins

Always loaded, no environment variable conditions:

| Plugin | Responsibility |
|--------|---------------|
| `LoggerPlugin` | Writes every bus message to `data/events.db` (SQLite). The permanent record. |
| `SignalPlugin` | Handles SIGTERM/SIGINT — calls `uninstall()` on all plugins, then exits. |
| `CLIPlugin` | Reads stdin commands for local debugging. |
| `SchedulerPlugin` | Fires `cron.<id>` events from `workspace/crons/*.yaml` and runtime `command.schedule` messages. |

Core plugins are loaded first. They must be present before any integration plugin installs, because some integration plugins subscribe to `cron.#` (RouterPlugin) or assume the event log is running (LoggerPlugin is first).

### Integration plugins — always on

Loaded on every startup, but some are no-ops if their configuration is missing:

| Plugin | Role |
|--------|------|
| `RouterPlugin` | Translates `message.inbound.#` and `cron.#` into `agent.skill.request` |
| `AgentRuntimePlugin` | Registrar: reads `workspace/agents/*.yaml`, registers `ProtoSdkExecutor` instances |
| `SkillBrokerPlugin` | Registrar: reads `workspace/agents.yaml`, registers `A2AExecutor` instances |
| `SkillDispatcherPlugin` | Sole `agent.skill.request` subscriber; dispatches via `ExecutorRegistry` |
| `WorldStateEngine` | Generic domain poller; domains registered via `discoverAndRegister()` |
| `GoalEvaluatorPlugin` | Subscribes to `world.state.#`; evaluates goals; emits `world.goal.violated` |
| `PlannerPluginL0` | Subscribes to `world.goal.violated`; selects actions from `ActionRegistry` |
| `ActionDispatcherPlugin` | Subscribes to `world.action.plan`; fires actions with WIP limit |
| `CeremonyPlugin` | Subscribes to `ceremony.#.execute`; dispatches skills on schedule |

`AgentRuntimePlugin` and `SkillBrokerPlugin` are registrars — they install with no bus subscriptions. They must run before `SkillDispatcherPlugin` finishes loading if dynamic skill resolution is expected, but since the bus is in-memory and synchronous, early messages are queued until all plugins have installed.

### Integration plugins — condition-gated

Loaded only when their prerequisite environment variable is set:

| Plugin | Condition | Role |
|--------|-----------|------|
| `DiscordPlugin` | `DISCORD_BOT_TOKEN` | Discord gateway: inbound @mentions, outbound replies |
| `GitHubPlugin` | `GITHUB_TOKEN` or `GITHUB_APP_ID` | GitHub webhooks, comment posting |
| `PlanePlugin` | (always, Plane config optional) | Plane webhook adapter |

Skipping a plugin on missing config is safe because all communication is through the bus. If DiscordPlugin is not loaded, messages are never published to `message.inbound.discord.#`, so nothing breaks — there is just no Discord input source.

### Workspace plugins

Loaded from `workspace/plugins/`. Each `.ts` file exports a default `Plugin` implementation. These are the right place for deployment-specific extensions that don't belong in the core codebase.

Workspace plugins are loaded last, after all core and integration plugins. They can safely subscribe to any topic because the topics they care about are already published by the time they receive messages.

## Ordering guarantees

The only hard ordering requirement is:

1. `LoggerPlugin` is loaded first (all subsequent bus activity is logged)
2. Registrar plugins (`AgentRuntimePlugin`, `SkillBrokerPlugin`) are loaded before `SkillDispatcherPlugin` first processes a message

Requirement 2 is satisfied in practice because all plugins are loaded before the HTTP server starts accepting requests and before the first cron fires. Bus messages published during plugin loading are queued and delivered after all plugins have installed.

## Lifecycle

```
startup:
  for each plugin in load order:
    plugin.install(bus)

  # All plugins installed — server starts accepting traffic

shutdown (SIGTERM):
  bus.drain()              # Wait for in-flight messages to complete
  for each plugin in reverse order:
    plugin.uninstall()
  process.exit(0)
```

`uninstall()` is called in reverse load order so plugins that depend on downstream infrastructure (e.g. DatabasePlugin) outlive the plugins that use them.

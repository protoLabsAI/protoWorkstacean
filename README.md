# WorkStacean

A generic message bus with plugin architecture. Signal in, agent replies.

## Current State

**Architecture:**
- Generic in-memory event bus with hierarchical topic matching (`#`, `*`)
- Plugin system: core plugins always loaded, built-in plugins opt-in
- SQLite event log captures all messages with correlation IDs

**Core Plugins:**
- `LoggerPlugin` - subscribes to `#`, writes all messages to `data/events.db`
- `CLIPlugin` - stdin reader, publishes commands to bus
- `SignalPlugin` - WebSocket listener for inbound, subscribes to `message.outbound.signal.#` for replies
- `AgentPlugin` - Pi SDK agent with ReAct loop, tool calling, persistent JSONL sessions

**Built-in Plugins (disabled by default):**
- `EchoPlugin` - replies to inbound messages with "Echo: {content}" (enable via `ENABLED_PLUGINS=echo`)

## Quick Start

```bash
# Copy environment config
cp .env.dist .env
# Edit .env with your settings
# Start
bun run src/index.ts
# Or with debug
DEBUG=1 bun run src/index.ts
```

## Model Configuration

Edit `models.json` to configure your LLM endpoint:

```json
{
  "providers": {
    "local-llm": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "apiKey": "sk-dummy",
      "models": [
        {
          "id": "default",
          "name": "Local LLM",
          "reasoning": true,
          "contextWindow": 32000,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

The agent automatically reads `models.json` from the project directory.

## CLI Commands

```
signal +1234 hello    Send message to signal number
topics                Show available topics
consumers             Show active consumers
help                  Show commands
{"topic":"..."}       Raw JSON publish
```

## Environment Variables

See `.env.dist` for full configuration.

## Topic Hierarchy

```
message.inbound.#         All inbound messages
message.inbound.signal.#  Inbound from Signal
message.outbound.#        All outbound messages
message.outbound.signal.# Outbound to Signal
command.#                 CLI commands
```

## Plugin Interface

```typescript
interface Plugin {
  name: string;
  description: string;
  capabilities: string[];
  install(bus: EventBus): void;
  uninstall(): void;
}
```

Plugins subscribe to topics and publish responses. The bus handles routing.

## Architecture Notes

- Agent subscribes to `message.inbound.#` and `command.#`
- Signal subscribes to `message.outbound.signal.#`
- Logger subscribes to `#` (everything)
- Correlation IDs link request/response pairs
- Sessions persisted as JSONL files at `~/.pi/agent/sessions/`
- Pi SDK reads `AGENTS.md` and other `.md` files for context automatically

## File Structure

```
lib/
  bus.ts              Core EventBus with topic matching
  types.ts            Shared interfaces
  plugins/
    agent.ts          Pi SDK agent with tools
    cli.ts            CLI input handler
    echo.ts           Echo test plugin
    logger.ts         SQLite event logger
    signal.ts         Signal bridge
    archive/
      agent-custom.ts Custom ReAct agent (archived)
src/
  index.ts            Plugin wiring
  *.test.ts           Tests
models.json           LLM provider configuration
```

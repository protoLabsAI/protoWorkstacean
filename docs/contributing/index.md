# Contributing

Contributions to protoWorkstacean are welcome. This section covers how to get started, where the key entry points are, and the conventions the codebase follows.

## Key entry points

| File / Directory | What it is |
|-----------------|------------|
| `src/index.ts` | Application bootstrap — wires all plugins, starts the HTTP server |
| `src/executor/` | Executor layer: `IExecutor`, `ExecutorRegistry`, `SkillDispatcherPlugin`, four executor implementations |
| `src/plugins/` | All plugin implementations (GOAP, ceremonies, skill broker, agent runtime, etc.) |
| `src/router/` | `RouterPlugin` + `SkillResolver` + `ProjectEnricher` |
| `src/agent-runtime/` | `AgentRuntimePlugin`, `AgentDefinitionLoader`, `ProtoSdkExecutor` |
| `src/world/` | Domain discovery |
| `src/engines/` | `WorldStateEngine` |
| `src/lib/` | Shared types (`BusMessage`, `Plugin`, `EventBus`) and utilities |
| `workspace/` | Runtime configuration (YAML files, not TypeScript) |
| `test/` | Integration tests |
| `__tests__/` | Unit tests co-located with source (some plugins have `__tests__/` directories) |

## Where to start for common tasks

**Add a new plugin**: create `src/plugins/my-plugin.ts`, implement `Plugin`, wire it into `src/index.ts`. See [explanation/plugin-system.md](../explanation/plugin-system.md) for the interface.

**Add a new executor type**: implement `IExecutor` in `src/executor/executors/`, export it, register it in the appropriate plugin's `install()`. See [reference/executor-types.md](../reference/executor-types.md).

**Change the HTTP API**: routes are defined in `src/services/` or directly in `src/index.ts`. Follow the existing pattern: define request/response types, add auth middleware for write endpoints.

**Add a new goal type**: implement a new evaluator in `src/evaluators/`, register it in `GoalEvaluatorPlugin`. Evaluators are small pure functions.

## Development setup

See [development.md](./development.md) for install instructions, running tests, and the test structure.

## Code style

- TypeScript strict mode (`tsconfig.json` has `"strict": true`)
- No default exports in `.ts` files — named exports only (exception: `_meta.ts` files use default export)
- JSDoc comments on public interfaces and complex functions
- Tests use `bun:test` — `describe`, `test`, `expect`

## Pull request expectations

- Every new plugin should have at least a basic install/uninstall test
- New executor types should have a unit test with a mock `SkillRequest`
- Changes to YAML schemas should update `docs/reference/workspace-files.md`
- Changes to HTTP endpoints should update `docs/reference/http-api.md`

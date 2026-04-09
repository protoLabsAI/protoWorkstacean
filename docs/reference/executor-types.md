---
title: Executor Types Reference
---

The executor layer is the uniform interface through which all skill work is dispatched. Every agent — in-process or external — is wrapped in an `IExecutor` implementation and registered in `ExecutorRegistry`.

## IExecutor interface

```typescript
interface IExecutor {
  /** Identifies this executor type in logs and diagnostics. */
  readonly type: string;

  execute(req: SkillRequest): Promise<SkillResult>;
}
```

---

## SkillRequest

```typescript
interface SkillRequest {
  /** Skill name to execute (e.g. "sitrep", "pr_review"). */
  skill: string;

  /** Natural language task description. Preferred over prompt when both are present. */
  content?: string;

  /** Explicit prompt override. */
  prompt?: string;

  /** Trace ID — propagated unchanged from the originating bus message. Never changes within a flow. */
  correlationId: string;

  /** Parent span ID — the bus message.id that produced this SkillRequest. */
  parentId?: string;

  /** Topic to publish the response on. */
  replyTopic: string;

  /** Full original payload. Executors that need extra context (e.g. projectSlug, github.*) read it here. */
  payload: Record<string, unknown>;
}
```

---

## SkillResult

```typescript
interface SkillResult {
  /** Output text. Empty string on error. */
  text: string;

  /** True if execution failed. */
  isError: boolean;

  /** Propagated trace ID. */
  correlationId: string;

  /** Structured data returned by function or workflow executors. Undefined for agent executors. */
  data?: unknown;
}
```

---

## ExecutorRegistration

```typescript
interface ExecutorRegistration {
  /** Skill name this registration handles. null = default (catch-all). */
  skill: string | null;

  executor: IExecutor;

  /** Agent name for target-based routing (e.g. "ava", "quinn"). */
  agentName?: string;

  /** Higher priority wins when multiple registrations match the same skill. */
  priority: number;
}
```

---

## ExecutorRegistry

`ExecutorRegistry` maps `(skill, targets[])` pairs to `IExecutor` instances.

**Resolution order**:
1. **Named target match** — if `targets` is non-empty, find the first registration whose `agentName` is in `targets`. Explicit targets override skill-based routing entirely.
2. **Skill-specific match** — find all registrations whose `skill` matches, sorted by `priority` descending. The highest-priority registration wins.
3. **Default executor** — the executor registered via `registerDefault()`.
4. **null** — no match found. `SkillDispatcherPlugin` logs a warning and drops the request.

**Key methods**:

```typescript
class ExecutorRegistry {
  register(skill: string, executor: IExecutor, opts?: { agentName?: string; priority?: number }): void;
  registerDefault(executor: IExecutor): void;
  resolve(skill: string, targets?: string[]): IExecutor | null;
  list(): ExecutorRegistration[];
}
```

---

## ProtoSdkExecutor

**type**: `"proto-sdk"`

Runs a skill as an in-process Claude Code SDK session. The agent's `systemPrompt`, `tools`, and `maxTurns` come from its `workspace/agents/<name>.yaml` definition.

**Registered by**: `AgentRuntimePlugin` at install time — one executor per agent YAML file.

**Constructor**:
```typescript
new ProtoSdkExecutor(agentDef: AgentDefinition, toolRegistry: ToolRegistry)
```

**Behaviour**:
- Instantiates a Claude Code SDK session with the agent's system prompt
- Injects the whitelisted `tools` as MCP tools
- Runs up to `maxTurns` agentic turns
- Returns the final assistant message as `SkillResult.text`
- Propagates `correlationId` through the session context

**When to use**: Any agent that should run inside the workstacean process, with direct access to workstacean bus tools.

---

## A2AExecutor

**type**: `"a2a"`

Dispatches a skill to an external agent over HTTP using JSON-RPC 2.0. Sends distributed trace headers on every request.

**Registered by**: `SkillBrokerPlugin` at install time — one executor per agent in `workspace/agents.yaml`.

**Constructor**:
```typescript
new A2AExecutor(config: {
  name: string;
  url: string;
  apiKeyEnv?: string;
  timeoutMs?: number;  // Default: 110_000ms
})
```

**Request shape** (`message/send` JSON-RPC 2.0):
```json
{
  "jsonrpc": "2.0",
  "method": "message/send",
  "params": {
    "message": { "role": "user", "parts": [{ "kind": "text", "text": "..." }] },
    "contextId": "<correlationId>",
    "metadata": { "skillHint": "...", "correlationId": "...", "parentId": "..." }
  }
}
```

**HTTP headers sent**:
```
Content-Type: application/json
X-Correlation-Id: <correlationId>
X-Parent-Id: <parentId>   (if present)
X-API-Key: <resolved from apiKeyEnv>
```

**When to use**: Any agent running in a separate service (ava, quinn, etc.) that exposes a standard A2A endpoint.

---

## FunctionExecutor

**type**: `"function"`

Wraps a plain async function as an executor. No agent or external call is involved.

**Constructor**:
```typescript
type SkillFn = (req: SkillRequest) => Promise<SkillResult>;
new FunctionExecutor(fn: SkillFn)
```

**When to use**: Data transformations, in-process state mutations, test stubs, or any skill that doesn't need an LLM.

---

## WorkflowExecutor

**type**: `"workflow"`

Executes a sequence of skill steps. Each step resolves its own executor from the registry, enabling multi-agent workflows with a shared `correlationId`.

**Constructor**:
```typescript
new WorkflowExecutor(
  steps: Array<{ skill: string; targets?: string[] }>,
  registry: ExecutorRegistry
)
```

**When to use**: Multi-step workflows where output from one skill feeds the next, or where different skills in sequence must share trace context.

---
title: Architecture
---

_Conceptual overview of how protoWorkstacean's components connect and why they are designed the way they are._

---

## System overview

```mermaid
flowchart TD
    subgraph Surfaces["External Surfaces"]
        GH[GitHub webhooks]
        DC[Discord gateway]
        LN[Linear webhooks]
        HTTP["HTTP API :3000\n/publish · /api/*"]
        MCP["MCP Server\n(Claude Code agents)"]
    end

    BUS[("Event Bus\nin-process pub/sub\nhierarchical topics")]

    subgraph Adapters["Interface Plugins"]
        GHP[GitHubPlugin]
        DCP[DiscordPlugin]
        LNP[LinearPlugin]
    end

    subgraph Routing["Skill Routing"]
        RTP["RouterPlugin\nmessage.inbound.# + cron.#\n→ agent.skill.request"]
        SDP["SkillDispatcherPlugin\nagent.skill.request subscriber\n(sole consumer)"]
        REG["ExecutorRegistry\nresolve(skill, targets)"]
    end

    subgraph Registrars["Registrars (install-time only)"]
        ART["AgentRuntimePlugin\nworkspace/agents/*.yaml\n→ DeepAgentExecutor"]
        SKB["SkillBrokerPlugin\nworkspace/agents.yaml\n→ A2AExecutor"]
    end

    subgraph Executors["Executor implementations"]
        PSE["DeepAgentExecutor\nLangGraph createReactAgent\nin-process"]
        A2AE["A2AExecutor\nHTTP JSON-RPC 2.0 + SSE\nX-Correlation-Id · X-Parent-Id"]
    end

    subgraph WorldEngine["World Engine"]
        WSE["WorldStateEngine\ngeneric domain poller\nregisterDomain(name, collector, tickMs)"]
        DD["domain-discovery\nprojects.yaml → workspace/domains.yaml\nworkspace/actions.yaml"]
        GEP["GoalEvaluatorPlugin\nworkspace/goals.yaml"]
        PL0["PlannerPluginL0\nActionRegistry"]
        ADP["ActionDispatcherPlugin\nWIP limit: 5"]
    end

    subgraph ProtoMakerTeam["protoMaker team (external A2A runtime)"]
        PM_A2A["POST /a2a\nJSON-RPC 2.0"]
        PM_WORLD["/api/world/board\n/api/world/agent-health"]
    end

    GH --> GHP
    DC --> DCP
    LN --> LNP
    HTTP --> BUS
    MCP --> BUS

    GHP & DCP & LNP --> BUS

    BUS -- "message.inbound.#\ncron.#" --> RTP
    RTP -- "agent.skill.request" --> BUS
    BUS -- "agent.skill.request" --> SDP
    SDP --> REG
    REG --> PSE & A2AE

    ART -- "register DeepAgentExecutor" --> REG
    SKB -- "register A2AExecutor" --> REG

    A2AE --> PM_A2A

    DD -- "registerDomain\nupsert(action)" --> WSE
    WSE -- "HTTP poll" --> PM_WORLD
    WSE -- "world.state.updated" --> GEP
    GEP -- "world.goal.violated" --> BUS
    BUS --> PL0
    PL0 -- "world.action.plan" --> BUS
    BUS --> ADP
    ADP -- "agent.skill.request\nceremony.*.execute\nmessage.outbound.*" --> BUS
```

---

## The event bus

The bus is the only communication channel. No plugin talks directly to another plugin — everything goes through `bus.publish()` and `bus.subscribe()`. Topic matching is hierarchical: `#` matches anything, `*` matches one segment.

This constraint is what makes the system composable. Adding Discord support doesn't touch the GitHub plugin. Adding a new executor type doesn't touch the routing logic. Plugins are independently installable and testable.

---

## Executor layer

The executor layer is the unified dispatch path for all agent skill calls. Before it existed, `AgentPlugin` and `A2APlugin` both subscribed to `agent.skill.request` and raced for messages. Adding a third agent type required a third subscriber.

The executor layer fixes this with a clean separation:

- **Registrars** (`AgentRuntimePlugin`, `SkillBrokerPlugin`) — register executors into `ExecutorRegistry` at `install()` time, no bus subscriptions
- **Dispatcher** (`SkillDispatcherPlugin`) — sole subscriber to `agent.skill.request`, delegates to the registry

```
agent.skill.request
  → SkillDispatcherPlugin
    → ExecutorRegistry.resolve(skill, targets?)
      1. Named target: any registration whose agentName ∈ targets[]
      2. Skill match: highest priority registration where skill matches
      3. Default executor
      4. null → error response, message dropped
    → executor.execute(SkillRequest)
      → result published to replyTopic
```

`SkillRequest` carries `correlationId` (trace-id) and `parentId` (parent span-id), set by `SkillDispatcherPlugin` from the triggering bus message.

See [Executor Layer](./executor-layer) for the full design rationale.

---

## World Engine — GOAP homeostatic loop

The `WorldStateEngine` is completely generic. It knows nothing about boards, agents, or CI. All domain knowledge lives in the protoMaker team's `workspace/domains.yaml`.

Domain discovery runs at startup:

```
WORKSPACE_DIR/projects.yaml
  → for each project with projectPath:
      {projectPath}/workspace/domains.yaml   → engine.registerDomain(name, httpCollector, tickMs)
      {projectPath}/workspace/actions.yaml   → actionRegistry.upsert(action)
```

Domain URLs support `${ENV_VAR}` interpolation. The protoMaker team server exposes `/api/world/board` and `/api/world/agent-health` as pollable endpoints.

```mermaid
flowchart LR
    subgraph Domains["protomaker/workspace/domains.yaml"]
        D1["board — 30s"]
        D2["agent-health — 15s"]
    end

    Domains --> WSE["WorldStateEngine\nWorldState.domains\nRecord‹string, WorldStateDomain‹unknown››"]
    WSE -- "world.state.updated" --> GEP["GoalEvaluatorPlugin"]
    GEP -- "world.goal.violated" --> PL0["PlannerPluginL0"]
    PL0 --> ADP["ActionDispatcherPlugin"]
    ADP -- "agent.skill.request" --> BUS["Event Bus"]
```

See [World Engine](./world-engine) for the design rationale.

---

## Distributed tracing

Every `BusMessage` carries:

| Field | Role | Changes? |
|---|---|---|
| `correlationId` | W3C trace-id — links every message in a request tree | Never |
| `parentId` | Parent span-id — = triggering message's `id` | At each hop |

`RouterPlugin` sets `parentId` when translating inbound messages to `agent.skill.request`. `A2AExecutor` forwards both as `X-Correlation-Id` and `X-Parent-Id` HTTP headers. External A2A agents (the protoMaker team, Quinn, protoContent) propagate `X-Correlation-Id` into their internal chat calls.

See [Distributed Tracing](./distributed-tracing).

---

## Message routing conventions

```
message.inbound.github.<owner>.<repo>.<event>.<number>   — inbound from GitHub
message.outbound.github.<owner>.<repo>.<number>          — outbound to GitHub comment
message.inbound.discord.<channelId>                      — inbound from Discord
message.outbound.discord.<channelId>                     — outbound to Discord
agent.skill.request                                      — route to agent via SkillDispatcher
ceremony.<id>.execute                                    — trigger named ceremony
world.goal.violated                                      — GOAP goal deviation detected
world.action.plan                                        — planner output ready for dispatch
security.incident.reported                               — immediate domain recollect
```

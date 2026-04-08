# Architecture — protoWorkstacean

protoWorkstacean is a homeostatic agent orchestration platform. It coordinates a fleet of AI agents across GitHub, Discord, Plane, and Google Workspace — and continuously monitors its own world state, acting autonomously to correct deviations from declared goals.

---

## System overview

```mermaid
flowchart TD
    subgraph Surfaces["External Surfaces"]
        GH[GitHub webhooks]
        DC[Discord gateway]
        PL[Plane webhooks]
        GG[Google Workspace]
    end

    subgraph Entry["Entry Points"]
        HTTP["HTTP API :3000\n/publish · /api/incidents\n/api/ceremonies/:id/run\n/api/world-state"]
        MCP["MCP Server\nmcp/server.ts\n(Claude Code agents)"]
    end

    BUS[("Event Bus\nin-process pub/sub\nhierarchical topics")]

    subgraph Adapters["Interface Plugins"]
        GHP[GitHubPlugin]
        DCP[DiscordPlugin]
        PLP[PlanePlugin]
        GGP[GooglePlugin]
        A2A[A2APlugin]
    end

    subgraph WorldEngine["World Engine"]
        WSC["WorldStateCollector\nservices · board · CI\nportfolio · security · agent_health"]
        GEP["GoalEvaluatorPlugin\ngoals.yaml"]
        PL0["PlannerPluginL0\nactions.yaml"]
        ADP["ActionDispatcherPlugin\nWIP limit: 5  fireAndForget"]
    end

    subgraph Ceremonies["Ceremony Pipeline"]
        CRP["CeremonyPlugin\nworkspace/ceremonies/*.yaml"]
        SKB["SkillBrokerPlugin"]
    end

    subgraph Runtime["Agent Runtime (in-process)"]
        ART["AgentRuntimePlugin\nworkspace/agents/*.yaml"]
        TRG["ToolRegistry\npublish_event · get_world_state\nget_incidents · report_incident"]
    end

    subgraph Agents["External Agents (A2A / JSON-RPC 2.0)"]
        AVA[Ava]
        QNN[Quinn]
        FRK[Frank]
        JON[Jon / Cindi]
        RSR[Researcher]
    end

    GH --> GHP
    DC --> DCP
    PL --> PLP
    GG --> GGP
    MCP --> HTTP
    HTTP --> BUS

    GHP <--> BUS
    DCP <--> BUS
    PLP <--> BUS
    GGP <--> BUS
    A2A <--> BUS

    WSC -- "world.state.updated" --> GEP
    GEP -- "world.goal.violated" --> BUS
    BUS -- "world.goal.violated" --> PL0
    PL0 -- "world.action.plan" --> BUS
    BUS -- "world.action.plan" --> ADP
    ADP -- "message.outbound.discord.alert\nceremony.*.execute\nagent.skill.request" --> BUS

    BUS -- "ceremony.*.execute" --> CRP
    CRP -- "agent.skill.request" --> BUS
    BUS -- "agent.skill.request" --> ART
    ART -- "proto CLI subprocess\n@protolabsai/sdk" --> TRG
    ART -- "fallthrough\n(unknown agents)" --> SKB
    SKB --> A2A

    A2A --> AVA & QNN & FRK & JON & RSR
```

---

## World Engine — GOAP homeostatic loop

The World Engine continuously monitors system state and autonomously closes deviations from declared goals. No human in the loop for routine corrections.

```mermaid
flowchart LR
    subgraph Collectors["WorldStateCollector (per-domain tickers)"]
        SVC["services\n30s"]
        BRD["board\n60s"]
        CI["CI\n5min"]
        PRT["portfolio\n15min"]
        SEC["security\n30s"]
        AGH["agent_health\n60s"]
    end

    subgraph Goals["goals.yaml"]
        G1["flow.efficiency_healthy\nThreshold ≥ 0.35"]
        G2["security.no_open_incidents\nInvariant · critical"]
        G3["agents.all_reachable\nInvariant · high"]
        G4["ci.success_rate_healthy\nThreshold ≥ 0.70"]
        G5["services.all_healthy\nInvariant · high"]
    end

    subgraph Actions["actions.yaml (tier_0 · fireAndForget)"]
        A1["alert.security_incident\nprio 100 → Discord alert"]
        A2["ceremony.security_triage\nprio 90 → quinn bug_triage"]
        A3["alert.agent_unreachable\n→ Discord alert"]
        A4["ci.debug_failures\n→ frank ci_debug"]
        A5["ceremony.service_health_check\n→ health_check ceremony"]
    end

    Collectors --> GEP["GoalEvaluatorPlugin\nevaluates all goals\nagainst current world state"]
    GEP -- "violation detected" --> PL0["PlannerPluginL0\nselects highest-priority\napplicable actions"]
    PL0 --> ADP["ActionDispatcherPlugin\nWIP limit: 5\npublishes to action topic"]
    ADP --> A1 & A2 & A3 & A4 & A5

    SEC -. "security.incident.reported\n(immediate re-collect)" .-> SEC
```

---

## Incident pipeline

When a security or operational incident is reported — via the MCP server, HTTP API, or a Claude Code agent — it flows through the full GOAP pipeline:

```mermaid
sequenceDiagram
    participant U as User / Claude Code
    participant MCP as MCP Server
    participant API as HTTP API
    participant BUS as Event Bus
    participant WSC as WorldStateCollector
    participant GOAP as Goal → Planner → Dispatcher
    participant DC as Discord
    participant Q as Quinn (bug_triage)

    U->>MCP: report_incident(title, severity, projectSlug)
    MCP->>API: POST /api/incidents
    API->>BUS: security.incident.reported
    BUS->>WSC: immediate re-collect security domain
    WSC-->>GOAP: openIncidents > 0 → goal violated
    GOAP->>BUS: alert.security_incident (prio 100)
    GOAP->>BUS: ceremony.security_triage (prio 90)
    BUS->>DC: Discord alert embed
    BUS->>Q: bug_triage skill → triage + board issue
```

---

## Message routing conventions

```
message.inbound.github.<owner>.<repo>.<event>.<number>   — inbound from GitHub
message.outbound.github.<owner>.<repo>.<number>          — outbound to GitHub comment
message.inbound.discord.<channelId>                      — inbound from Discord
message.outbound.discord.<channelId>                     — outbound to Discord channel
agent.skill.request                                      — route to agent via SkillBroker
ceremony.<id>.execute                                    — trigger named ceremony
world.goal.violated                                      — GOAP goal deviation detected
world.action.plan                                        — planner output ready for dispatch
security.incident.reported                               — immediate security domain recollect
```

---

## Workspace config — tracked vs gitignored

| File | Purpose | Git |
|------|---------|-----|
| `workspace/actions.yaml` | GOAP action rules | tracked |
| `workspace/goals.yaml` | GOAP goal definitions | tracked |
| `workspace/ceremonies/*.yaml` | ceremony schedules + skill routing | tracked |
| `workspace/agents/*.yaml` | in-process agent definitions (model, tools, skills) | **gitignored** |
| `workspace/agents.yaml` | external A2A agent registry (URLs, chains) | **gitignored** |
| `workspace/projects.yaml` | project registry, Discord channels | **gitignored** |
| `workspace/discord.yaml` | bot config, slash commands | **gitignored** |
| `workspace/google.yaml` | Google Workspace config | **gitignored** |
| `workspace/incidents.yaml` | live security incident state | **gitignored** |

Copy `*.example` counterparts to bootstrap a new deployment.

---

## External services

| Service | Default URL | Purpose |
|---------|------------|---------|
| LiteLLM Gateway | `LLM_GATEWAY_URL` (default: `http://gateway:4000/v1`) | One-stop LLM routing for all in-process agents |
| Qdrant | `http://qdrant:6333` | Vector search (Quinn PR review) |
| Ollama | `http://ollama:11434` | Local embeddings |
| GitHub API | `https://api.github.com` | PRs, diffs, comments |
| Plane | `PLANE_BASE_URL` | Project board |
| Discord | bot token | Notifications, slash commands |

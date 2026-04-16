---
title: Guides
---

Task-oriented guides for common operations in protoWorkstacean.

## Available guides

| Guide | Description |
|-------|-------------|
| [Add an agent](./add-an-agent) | Register an in-process agent (YAML + DeepAgentExecutor / LangGraph) or an external A2A agent |
| [Build an A2A agent](./build-an-a2a-agent) | Agent-author recipe: the endpoint, task lifecycle, hardening, automatic health, and scheduled work |
| [Extend an A2A agent](./extend-an-a2a-agent) | Opt in to the x-protolabs extensions pack (cost, confidence, effect-domain, blast, hitl-mode) — smarter planner + HITL with minimal card changes |
| [Add a domain](./add-a-domain) | Poll a custom HTTP endpoint and expose it as a world-state domain |
| [Add goals and actions](./add-goals-and-actions) | Write goal definitions (Invariant, Threshold, Distribution) and matching actions with preconditions and effects |
| [Create a ceremony](./create-a-ceremony) | Schedule a recurring fleet ritual — a skill dispatched on a cron expression |
| [Integrate an external app](./integrate-external-app) | Connect any service to the GOAP loop as a reactive actor — purely YAML-driven |
| [Deploy with Docker](./deploy-with-docker) | Production deployment: Docker Compose, env vars, workspace volume mount, health check |

## Where to start

If you have just completed the [Getting Started tutorial](../../tutorials/getting-started), the natural next guides are:

1. **[Add an agent](./add-an-agent)** — bring your own agent into the fleet
2. **[Build an A2A agent](./build-an-a2a-agent)** — opinionated recipe for writing the agent itself (endpoint, task lifecycle, hardening, automatic health)
3. **[Add goals and actions](./add-goals-and-actions)** — let the world engine react autonomously to state changes
4. **[Create a ceremony](./create-a-ceremony)** — schedule recurring work

For background on why things work the way they do, see the [Explanation](../../explanation/index) section.

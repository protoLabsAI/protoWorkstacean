---
title: Guides
---

Task-oriented guides for common operations in protoWorkstacean.

## Available guides

| Guide | Description |
|-------|-------------|
| [Add an agent](./add-an-agent.md) | Register an in-process agent (YAML + ProtoSdkExecutor) or an external A2A agent |
| [Add a domain](./add-a-domain.md) | Poll a custom HTTP endpoint and expose it as a world-state domain |
| [Add goals and actions](./add-goals-and-actions.md) | Write goal definitions (Invariant, Threshold, Distribution) and matching actions with preconditions and effects |
| [Create a ceremony](./create-a-ceremony.md) | Schedule a recurring fleet ritual — a skill dispatched on a cron expression |
| [Deploy with Docker](./deploy-with-docker.md) | Production deployment: Docker Compose, env vars, workspace volume mount, health check |

## Where to start

If you have just completed the [Getting Started tutorial](../tutorials/getting-started.md), the natural next guides are:

1. **[Add an agent](./add-an-agent.md)** — bring your own agent into the fleet
2. **[Add goals and actions](./add-goals-and-actions.md)** — let the world engine react autonomously to state changes
3. **[Create a ceremony](./create-a-ceremony.md)** — schedule recurring work

For background on why things work the way they do, see the [Explanation](../explanation/index.md) section.

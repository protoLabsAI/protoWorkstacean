---
title: Guides
---

Task-oriented guides for common operations in protoWorkstacean.

## Available guides

| Guide | Description |
|-------|-------------|
| [Add an agent](./add-an-agent) | Register an in-process agent (YAML + ProtoSdkExecutor) or an external A2A agent (with auth schemes + card auto-discovery) |
| [A2A streaming](./a2a-streaming) | Enable SSE streaming, artifact chunking, long-running tasks, and native `input-required` HITL |
| [HITL](./hitl) | Human-in-the-loop approval gates (plan gate + operational gate, both built on the A2A `input-required` state) |
| [Add a domain](./add-a-domain) | Poll a custom HTTP endpoint and expose it as a world-state domain |
| [Add goals and actions](./add-goals-and-actions) | Write goal definitions (Invariant, Threshold, Distribution) and matching actions with preconditions and effects |
| [Create a ceremony](./create-a-ceremony) | Schedule a recurring fleet ritual — a skill dispatched on a cron expression |
| [Integrate an external app](./integrate-external-app) | Connect any service to the GOAP loop as a reactive actor — purely YAML-driven |
| [Deploy with Docker](./deploy-with-docker) | Production deployment: Docker Compose, env vars, workspace volume mount, health check |

## Where to start

If you have just completed the [Getting Started tutorial](../../tutorials/getting-started), the natural next guides are:

1. **[Add an agent](./add-an-agent)** — bring your own agent into the fleet
2. **[Add goals and actions](./add-goals-and-actions)** — let the world engine react autonomously to state changes
3. **[Create a ceremony](./create-a-ceremony)** — schedule recurring work

For background on why things work the way they do, see the [Explanation](../../explanation/index) section.

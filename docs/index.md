---
title: protoWorkstacean Docs
---

**protoWorkstacean** is a switchboard for the protoLabs agent ecosystem. It schedules things, receives events from the outside world (Discord, GitHub, Linear, Google), and routes both into the right agent — wherever that agent lives (in-process DeepAgent, remote A2A on another machine, or a function handler). Plugins extend its reach to new tools and infrastructure.

## Where to start

| I want to… | Go to… |
|---|---|
| Install and run my first skill execution | [Tutorials → Getting Started](./tutorials/getting-started) |
| Add an agent or ceremony | [Guides](./guides/) |
| Look up env vars, HTTP API, bus topics, or config schemas | [Reference](./reference/) |
| Understand how the executor layer works | [Explanation](./explanation/) |
| Contribute code or extend the platform | [Contributing](./contributing/) |

## Documentation sections

### [Tutorials](./tutorials/getting-started)

Step-by-step walkthroughs for learning protoWorkstacean from scratch. Follow along to configure, deploy, and trigger your first skill execution.

### [Guides](./guides/)

Task-oriented how-tos for specific goals — adding agents, configuring ceremonies, building A2A agents, and deploying to production.

### [Reference](./reference/)

Exact, complete reference material: all environment variables, HTTP API endpoints, bus topics, workspace file schemas, and executor type signatures.

### [Explanation](./explanation/)

Conceptual documentation explaining how protoWorkstacean's subsystems work and why they are designed the way they are.

### [Contributing](./contributing/)

Architecture deep-dives, development workflow, and extension guides for contributors.

---
title: Integrations
---

protoWorkstacean connects to external services through **plugins** and runs agents through **runtimes**. Both are opt-in — a plugin only activates when its required env vars are set.

## Communication channels

[**Channels**](channels) is the single interface for adding, configuring, and routing all communication channels. One `workspace/channels.yaml` entry connects a platform channel to an agent and gives that agent its own bot identity.

## Platform integrations

| Integration | Triggers | Env var that enables it |
|-------------|----------|------------------------|
| [Discord](discord) | @mentions, slash commands, reactions | `DISCORD_BOT_TOKEN` |
| [GitHub](github) | Webhooks — issues, PRs, org events | `GITHUB_TOKEN` or `GITHUB_APP_ID` |
| [Plane](plane) | Issue webhooks → PRD + feature creation | `PLANE_BASE_URL` + `PLANE_API_KEY` |
| [Google Workspace](google-workspace) | Gmail polling, Calendar polling, Drive/Docs write | `GOOGLE_CLIENT_ID` |
| [Signal](signal) | Inbound/outbound Signal messages | `SIGNAL_URL` + `SIGNAL_NUMBER` |

## Memory

| Integration | What it does | Env var that enables it |
|-------------|-------------|------------------------|
| [User Memory (Graphiti)](memory) | Temporal knowledge graph — facts persist across conversations, scoped per user | `GRAPHITI_URL` |

## Agent runtimes

| Runtime | What it does | When to use |
|---------|-------------|-------------|
| [ProtoSdk](runtimes/proto-sdk) | In-process `@protolabsai/sdk` agent | Default for all new agents |
| [A2A](runtimes/a2a) | Dispatches to a remote agent over HTTP (JSON-RPC 2.0) | Agent lives in a separate service (ava, quinn) |
| [Pi SDK](runtimes/pi-sdk) | In-process `@mariozechner/pi-coding-agent` agent | Legacy — existing agents only |

See [Runtimes overview](runtimes/) for how the executor layer works and how to register a new runtime.

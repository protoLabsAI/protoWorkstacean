# protoWorkstacean Docs

Plugin, routing, and bus documentation. For deployment config (docker-compose, env vars, network setup) see the [homelab-iac repo](https://github.com/protoLabsAI/homelab-iac/blob/main/stacks/ai/docker-compose.yml).

| File | Description |
|------|-------------|
| [a2a.md](a2a.md) | A2A plugin — signal flow diagram, skill routing table, agent registry config, chain execution, bus topics |
| [discord.md](discord.md) | Discord plugin — setup, discord.yaml config reference, slash commands, bus topics, moderation |
| [github.md](github.md) | GitHub plugin — webhook setup, github.yaml config, signature validation, bus topics |
| [hitl.md](hitl.md) | Human-in-the-loop gate — plan/plan_resume flow, HITLRequest/Response types, renderers, expiry, testing |
| [plane-integration.md](plane-integration.md) | Plane integration — webhook setup via Django ORM, trigger rules, bidirectional sync, known gotchas |
| [scheduler.md](scheduler.md) | Cron scheduler — YAML format, bus commands, one-shot schedules, missed fire behavior |
| [extensions.md](extensions.md) | Agent extensions — Pi SDK runtime tools vs workspace bus plugins, when to use each |
| [testing.md](testing.md) | Testing methodology — test scripts, SQLite polling pattern, debug output |

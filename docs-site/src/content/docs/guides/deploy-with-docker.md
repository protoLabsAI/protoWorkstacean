---
title: Deploy with Docker
---

# Deploy with Docker

This guide covers a production-ready Docker Compose deployment: building the image, mounting the workspace volume, wiring secrets via environment variables, and verifying health.

## Prerequisites

- Docker >= 24
- Docker Compose v2

## Docker Compose

A `docker-compose.yml` is provided at the project root. Adjust it for your environment:

```yaml
services:
  workstacean:
    build:
      context: .
      target: production
    restart: unless-stopped
    env_file: .env
    environment:
      - WORKSPACE_DIR=/workspace
      - DATA_DIR=/data
      - TZ=America/New_York
    ports:
      # Expose the HTTP API on the host (adjust or remove for internal-only)
      - "3000:3000"
    volumes:
      # Workspace config (agents, goals, actions, ceremonies, domains)
      - ./workspace:/workspace
      # Persistent SQLite event log
      - data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

volumes:
  data:
```

## Environment file

Create `.env` next to `docker-compose.yml`. This file is loaded by `env_file` and never committed to source control.

```dotenv
# ── Required ──────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...
WORKSTACEAN_API_KEY=change-me-in-production

# ── Optional: external A2A agents ─────────────────────────────────────────────
AVA_BASE_URL=http://ava:3008
AVA_API_KEY=your-ava-key

# ── Optional: Discord integration ─────────────────────────────────────────────
DISCORD_BOT_TOKEN=Bot ...
DISCORD_GUILD_ID=1234567890

# ── Optional: GitHub integration ──────────────────────────────────────────────
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=your-webhook-secret

# ── Routing ───────────────────────────────────────────────────────────────────
ROUTER_DEFAULT_SKILL=sitrep

# ── HTTP ──────────────────────────────────────────────────────────────────────
WORKSTACEAN_HTTP_PORT=3000

# ── Storage ───────────────────────────────────────────────────────────────────
WORKSPACE_DIR=/workspace
DATA_DIR=/data
```

For a full list of all supported variables, see [reference/env-vars.md](../reference/env-vars.md).

## Workspace volume

The `workspace/` directory is mounted read-write so configuration changes can be applied without rebuilding the image:

```
./workspace/                  ← bind-mounted to /workspace in container
  agents/
    ava.yaml
    frank.yaml
  agents.yaml
  projects.yaml
  goals.yaml
  actions.yaml
  ceremonies/
    daily-standup.yaml
    security-triage.yaml
  domains.yaml
```

After editing any workspace file, restart the container:

```bash
docker compose restart workstacean
```

Hot-reload for workspace YAML files is not supported in the current version (except `projects.yaml` and skill keywords via `RouterPlugin`).

## Starting the stack

```bash
docker compose up -d
docker compose logs -f workstacean
```

Expected startup output:

```
[agent-runtime] loaded agent: ava (orchestrator, 5 skills)
[skill-broker] loaded 0 external agents
[ceremony-plugin] loaded 5 ceremonies
[world-state] domain discovery: 3 domains registered
[http] listening on :3000
[workstacean] ready
```

## Health check

The `/health` endpoint returns `200 OK` when the server is ready:

```bash
curl http://localhost:3000/health
# {"status":"ok","uptime":42.3}
```

Docker's healthcheck (`test: curl -f ...`) will restart the container if this endpoint stops responding.

## Production docker-compose with ava

If you run ava alongside workstacean in the same Compose project:

```yaml
services:
  workstacean:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      - WORKSPACE_DIR=/workspace
      - DATA_DIR=/data
      - AVA_BASE_URL=http://ava:3008
    volumes:
      - ./workspace:/workspace
      - data:/data
    depends_on:
      ava:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  ava:
    image: protoLabsAI/protoMaker:latest
    restart: unless-stopped
    env_file: .env.ava
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3008/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  data:
```

The `AVA_BASE_URL=http://ava:3008` uses Docker's internal DNS — the service name `ava` resolves automatically within the Compose network.

## Securing the HTTP API

The `/publish` endpoint requires `X-API-Key: $WORKSTACEAN_API_KEY`. Set a strong value in production. Other endpoints (`/health`, `/api/world-state`, etc.) do not require authentication by default — put workstacean behind a reverse proxy (nginx, Caddy) if you need to restrict access.

## Persisting the event log

The SQLite event log (`DATA_DIR/events.db`) records every bus message. Mount a named volume or host path to preserve it across container restarts:

```yaml
volumes:
  - /srv/workstacean/data:/data
```

## Related

- [Getting Started](../tutorials/getting-started.md)
- [Environment variables reference](../reference/env-vars.md)
- [HTTP API reference](../reference/http-api.md)

---
title: Deploy with Docker
---

This guide covers a production deployment: how code and config ship, building the image, mounting the workspace volume, wiring secrets, and verifying health.

## Prerequisites

- Docker >= 24
- Docker Compose v2

## How deployment works

protoWorkstacean separates **code** from **config**:

- **Code ships as an image.** Production runs `ghcr.io/protolabsai/workstacean:main`. [watchtower](https://containrrr.dev/watchtower/) watches that tag and auto-pulls + restarts the container whenever a new `:main` image is published (CI builds and pushes on every merge to `main`).
- **Workspace config ships as a host bind-mount.** The `workspace/` directory (agent YAMLs, ceremonies, `channels.yaml`) is mounted into the container and updated on the host with `git pull` — it is *not* baked into the image. This means config changes don't require an image rebuild.

Two config reload behaviours follow from that:

- **Ceremonies hot-reload.** Editing or adding a file under `workspace/ceremonies/` (then `git pull` on the host) is picked up live — no restart.
- **Agent YAMLs need a container restart.** Changes to `workspace/agents/*.yaml` or `workspace/agents.yaml` are read at startup; `docker compose restart workstacean` to apply them.

So the operational model is: **code lands via watchtower automatically; config lands via `git pull` on the host, with a restart only when you touched agent YAMLs.**

## Docker Compose

A `docker-compose.yml` is provided at the project root. Adjust it for your environment:

```yaml
services:
  workstacean:
    build:
      context: .
      target: release
    restart: unless-stopped
    env_file: .env
    environment:
      - WORKSPACE_DIR=/workspace
      - DATA_DIR=/data
      - TZ=America/New_York
    ports:
      # Single HTTP server: API + Astro dashboard + WebSocket event stream
      - "8080:8080"
    volumes:
      # Workspace config (agents, ceremonies, channels) — bind-mounted from host
      - ./workspace:/workspace
      # Persistent SQLite event log
      - data:/data

volumes:
  data:
```

The Dockerfile defines two runnable stages: `dev` (`bun run --watch`, used by the checked-in compose default) and `release` (`bun run`, no watcher — use it for production). There is no `production` stage. The checked-in `docker-compose.yml` targets `dev` for local development; flip `target` to `release` for a production build, or just run the published `ghcr.io/protolabsai/workstacean:main` image and let watchtower keep it current.

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
WORKSTACEAN_HTTP_PORT=8080

# ── Storage ───────────────────────────────────────────────────────────────────
WORKSPACE_DIR=/workspace
DATA_DIR=/data
```

For a full list of all supported variables, see [reference/env-vars.md](../reference/env-vars).

## Workspace volume

The `workspace/` directory is bind-mounted read-write, so configuration changes are applied on the host (via `git pull`) without rebuilding the image:

```
./workspace/                  ← bind-mounted to /workspace in container
  agents/
    ava.yaml
    frank.yaml
  agents.yaml
  channels.yaml
  ceremonies/
    daily-standup.yaml
    security-triage.yaml
```

After editing **agent** YAMLs, restart the container:

```bash
docker compose restart workstacean
```

Ceremonies under `workspace/ceremonies/` hot-reload — no restart needed.

## Starting the stack

```bash
docker compose up -d
docker compose logs -f workstacean
```

## Health check

The `/health` endpoint returns `200 OK` when the server is ready:

```bash
curl http://localhost:8080/health
# {"status":"ok","timestamp":1748534400000}
```

Put a healthcheck behind your orchestrator or reverse proxy against this endpoint.

## Dashboard

The Astro dashboard is built into the image (the Dockerfile's `dashboard-build` stage) and served by the same HTTP server on port `8080`. Once the stack is up:

```bash
open http://localhost:8080
```

Set `DISABLE_EVENT_VIEWER=1` in `.env` to skip the event-viewer plugin entirely (e.g. for headless deployments). See the [Dashboard reference](../reference/dashboard) for pages, API client, and cache behavior.

## Production docker-compose with ava

If you run ava alongside workstacean in the same Compose project:

```yaml
services:
  workstacean:
    image: ghcr.io/protolabsai/workstacean:main
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

The `/publish` endpoint requires `X-API-Key: $WORKSTACEAN_API_KEY`. Set a strong value in production. Other endpoints (`/health`, `/api/agents`, etc.) do not require authentication by default — put workstacean behind a reverse proxy (nginx, Caddy) if you need to restrict access.

## Persisting the event log

The SQLite event log (`DATA_DIR/events.db`) records every bus message. Mount a named volume or host path to preserve it across container restarts:

```yaml
volumes:
  - /srv/workstacean/data:/data
```

## Related

- [Getting Started](../tutorials/getting-started)
- [Environment variables reference](../reference/env-vars)
- [HTTP API reference](../reference/http-api)
- [Dashboard reference](../reference/dashboard)

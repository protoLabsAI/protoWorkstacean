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

Config reload behaviour by surface:

- **Ceremonies hot-reload.** Editing or adding a file under `workspace/ceremonies/` (then `git pull` on the host) is picked up live — no restart.
- **In-process agents hot-reload.** Adding, editing, or removing a `workspace/agents/*.yaml` (DeepAgent) is reconciled live within ~5s — no restart (ADR-0004 P1). A YAML that fails to parse keeps the running agent + logs a warning; in-flight work is never interrupted.
- **A2A agent entries still need a restart.** Changes to `workspace/agents.yaml` (remote A2A agents) are read at startup; `docker compose restart workstacean` to apply them. (Their *skills* still auto-refresh from the agent card every 10 min — only adding/removing the agent entry needs the restart, until the control-plane work extends hot-reload there.)

So the operational model is: **code lands via watchtower automatically; config lands via `git pull` on the host; ceremonies and in-process agents apply live, and only `workspace/agents.yaml` (A2A) edits need a restart.**

### Rollback

`:main` auto-deploys on every merge — there's no staging gate, so a bad `:main` ships. The image is also published by digest, so rollback is a tag flip, not a rebuild:

1. Find the last-good image digest in GHCR (or the prior `build-and-push` run's pushed digest).
2. Re-point the running container at it: `docker pull ghcr.io/protolabsai/workstacean@sha256:<digest>` and `docker tag` it to the tag watchtower watches, or set the compose `image:` to the pinned digest and `docker compose up -d workstacean`.
3. Revert the offending commit on `main` so the next `:main` build is clean (otherwise watchtower re-pulls the bad image).

Because `EnvSchema` makes every var optional, a lost secret degrades silently (an integration self-disables) rather than failing boot — check `/ready` and the startup logs after any deploy. Add must-have vars to a prod env profile if you want boot to fail loud instead.

### Graceful shutdown

On `SIGTERM` / `SIGINT` (every watchtower redeploy) the process drains before exiting: it stops the HTTP server, calls `uninstall()` on every plugin (closing webhook listeners, scheduler timers, Discord/Linear clients), flushes the Langfuse tracer, and closes the sqlite stores **checkpointing the WAL** so the last commits aren't lost. An `unhandledRejection` is logged loudly but kept alive (one bad async handler shouldn't take down the switchboard); an `uncaughtException` is logged and the process exits non-zero so the orchestrator restarts cleanly.

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
PROTOPEN_BASE_URL=http://steamdeck:7870
PROTOPEN_API_KEY=your-protopen-key

# ── Optional: Discord integration ─────────────────────────────────────────────
DISCORD_BOT_TOKEN=Bot ...
DISCORD_GUILD_ID=1234567890

# ── Optional: GitHub integration ──────────────────────────────────────────────
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=your-webhook-secret

# ── Routing ───────────────────────────────────────────────────────────────────
ROUTER_DEFAULT_SKILL=chat

# ── HTTP ──────────────────────────────────────────────────────────────────────
WORKSTACEAN_HTTP_PORT=8080

# ── Storage ───────────────────────────────────────────────────────────────────
WORKSPACE_DIR=/workspace
DATA_DIR=/data
```

For a full list of all supported variables, see [reference/env-vars.md](../reference/env-vars).

## Data volume + backups

The `workstacean-data` named volume holds the SQLite databases — `knowledge.db` (conversation memory + FTS5 + embeddings), `events.db` (the bus event log), `tasks.db` (in-flight A2A tasks), and push-notification configs. Losing it loses agent memory + the research corpus, so back it up.

- **Bounded growth.** `events.db` (the `#`-subscribed event sink) self-purges on a retention window — default 7 days, override with `LOGGER_EVENTS_RETENTION_MS` — and secret-keyed fields are redacted before persistence (#801). Other stores are bounded by their own caps.
- **Backup.** Schedule a periodic snapshot off-host, e.g. `sqlite3 /data/knowledge.db ".backup /backup/knowledge-$(date +%F).db"` from a sidecar/cron, or run [litestream](https://litestream.io) against the volume for continuous replication. Test the restore.

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

In-process agents (`workspace/agents/*.yaml`) hot-reload — no restart. After editing **`workspace/agents.yaml`** (A2A entries), restart the container:

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

## Production docker-compose

workstacean runs standalone — its in-process agents (Ava, Quinn, …) live inside the process, so there are no agent sidecars to deploy. Remote A2A agents (protopen) run on their own hosts and are reached over the network via their `*_BASE_URL` env vars.

```yaml
services:
  workstacean:
    image: ghcr.io/protolabsai/workstacean:main
    restart: unless-stopped
    env_file: .env
    environment:
      - WORKSPACE_DIR=/workspace
      - DATA_DIR=/data
      - PROTOPEN_BASE_URL=http://steamdeck:7870
    volumes:
      - ./workspace:/workspace
      - data:/data

volumes:
  data:
```

Remote A2A agents are reached over the network by their `*_BASE_URL` — e.g. `PROTOPEN_BASE_URL=http://steamdeck:7870` points at protopen on its own host. Use Docker's internal DNS (the service name) only for agents that actually run as sidecars in this Compose project.

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

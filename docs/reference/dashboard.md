---
title: Dashboard
---

The Workstacean dashboard is a static Astro + Preact site at `dashboard/` that replaces the legacy event viewer. It is the primary operational UI for the GOAP world engine, covering system health, world state, live events, goals, and project CI.

## Quick facts

| Field | Value |
|---|---|
| Source | `dashboard/` (standalone `package.json`) |
| Framework | Astro 6.x, static output |
| Islands | Preact (`@astrojs/preact`) hydrated with `client:load` |
| Theme | GitHub dark (`#0d1117` / `#161b22` / `#30363d`) |
| Build output | `dashboard/dist/` |
| Served by | `lib/plugins/event-viewer.ts` on port `8080` |
| API base | Same origin — plugin proxies `/api/*` and `/ws` to `WORKSTACEAN_HTTP_PORT` |

## Pages

All pages live under `dashboard/src/pages/`. Each one renders a `DashboardLayout` wrapper with a sidebar, a WebSocket status indicator in the header, and the page-specific component hydrated as a Preact island.

| Route | Component | Polls | Notes |
|---|---|---|---|
| `/` | `OverviewGrid` | 30 s | Health cards for services, agents, CI, PRs, flow efficiency, security, HITL pending |
| `/world-state` | `WorldStateViewer` | on demand | Live world-state snapshot with domain cards + JSON tree |
| `/events` | `EventStream` | WebSocket | Real-time bus event feed with filter, tabs, sticky header |
| `/goals` | `GoalStatus` + `OutcomesTable` | 30 s | Declarative goal pass/fail + GOAP action dispatch history |
| `/projects` | `ProjectsView` | 60 s | Per-project CI health bars + PR pipeline badges |

The sidebar nav is declared in `dashboard/src/layouts/DashboardLayout.astro`. The header WebSocket dot connects to `/ws` for a live/disconnected indicator, independent of the page-level polling.

## API client

`dashboard/src/lib/api.ts` is the single source of truth for all HTTP calls. It provides:

- **Envelope unwrap** — `{ success, data }` responses are auto-unwrapped so callers always see the inner payload.
- **In-memory cache with per-endpoint TTLs** — `getCiHealth`, `getPrPipeline`, etc. return cached values until their TTL expires.
- **Force refresh** — every getter accepts a `force: boolean` argument that bypasses the cache.
- **`peek<T>(path)`** — synchronous stale read used by components to seed state instantly on page revisits, so navigating away and back never shows a "Loading…" flash.
- **Typed response interfaces** — every endpoint has an exported `type *Response` so components get strict shapes.

Cache TTLs (defined in `api.ts`):

| Endpoint | TTL |
|---|---|
| `/api/world-state`, `/api/outcomes` | 15 s |
| `/api/services`, `/api/agent-health`, `/api/flow-metrics` | 30 s |
| `/api/security-summary` | 60 s |
| `/api/pr-pipeline` | 2 min |
| `/api/ci-health` | 5 min |
| `/api/branch-drift` | 10 min |

Pages set their own `POLL_INTERVAL_MS` on top of this; most pass `force: true` on the interval tick so they always refresh rather than hitting the cache.

## Adding a new page

1. Add a component under `dashboard/src/components/` — Preact, `.tsx`, no default export constraints beyond being a valid component.
2. Add an `.astro` page under `dashboard/src/pages/` that imports the component and renders it inside `<DashboardLayout>`:
   ```astro
   ---
   import DashboardLayout from "../layouts/DashboardLayout.astro";
   import MyThing from "../components/MyThing.tsx";
   ---
   <DashboardLayout title="My Thing" activePage="my-thing">
     <MyThing client:load />
   </DashboardLayout>
   ```
3. Add a nav entry to `navItems` in `DashboardLayout.astro`. Use the same `id` string as your `activePage` prop.
4. If the component needs new data, add a getter + response type to `dashboard/src/lib/api.ts` — do **not** call `fetch()` directly from components; cache seeding and envelope unwrap live in the api module.

## Build and serve

```bash
# Development
cd dashboard
bun install
bun run dev           # Astro dev server, hot reload, port 4321

# Production build
bun run build         # outputs dashboard/dist/

# Serve via main app
cd ..
bun run start         # event-viewer plugin picks up dashboard/dist automatically
open http://localhost:8080
```

The Docker image builds the dashboard as a dedicated stage between `install` and `release`, so production containers ship the compiled assets. See the `Dockerfile` for the exact stage layout.

## Env vars

| Variable | Effect |
|---|---|
| `DISABLE_EVENT_VIEWER` | Any non-empty value disables the plugin — the dashboard will not be served. |
| `WORKSTACEAN_HTTP_PORT` | Main HTTP port that `/api/*` is proxied to (default `3000`). |

The dashboard itself has no env vars — it's a static build. All runtime configuration lives on the server side.

## Related docs

- [HTTP API](./http-api) — every endpoint the dashboard consumes
- [World Engine](./world-engine) — what the world-state viewer is showing
- [Bus topics](./bus-topics) — events streamed to `/events`

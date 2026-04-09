---
title: Add a Domain
---

# Add a Domain

A **domain** is a named slot in the world state, backed by an HTTP collector that polls a URL on a fixed interval. WorldStateEngine is generic — it has no hardcoded knowledge of any service. Any HTTP endpoint that returns JSON can become a domain.

## Where domains are defined

Domains can be defined in two places:

1. **Global**: `workspace/domains.yaml` — applies to every project
2. **Per-project**: `workspace/<project-slug>/domains.yaml` — discovered via `projects.yaml`

Both files use the same schema. Per-project domains are merged into the global domain map at startup.

## Domain YAML schema

```yaml
# workspace/domains.yaml

domains:
  - name: my_service
    url: http://my-service:8080/status
    tickMs: 30000
    headers:
      X-API-Key: "${MY_SERVICE_API_KEY}"
      Accept: "application/json"
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Unique domain key. Accessible as `domains.<name>` in world state. |
| `url` | Yes | — | HTTP GET endpoint. Must return JSON. Supports `${ENV_VAR}` interpolation. |
| `tickMs` | No | `60000` | Poll interval in milliseconds. |
| `headers` | No | `{}` | HTTP headers sent with every request. Values support `${ENV_VAR}` interpolation. |

## ENV_VAR interpolation

Any string value (in `url` or `headers`) containing `${VAR_NAME}` is replaced with `process.env.VAR_NAME` at poll time. If the variable is not set, the literal `${VAR_NAME}` string is used, which will typically cause authentication to fail — check your logs if a domain shows collection errors.

Example with URL and header interpolation:

```yaml
domains:
  - name: ava_board
    url: "${AVA_BASE_URL}/api/world/board"
    tickMs: 60000
    headers:
      X-API-Key: "${AVA_API_KEY}"
```

Set in `.env`:

```dotenv
AVA_BASE_URL=http://ava:3008
AVA_API_KEY=super-secret
```

## Accessing domain data

Domain data is available:

**Via HTTP API:**

```bash
# All domains
curl http://localhost:3000/api/world-state

# Single domain
curl http://localhost:3000/api/world-state/my_service
```

Response shape:

```json
{
  "name": "my_service",
  "data": { "status": "ok", "latencyMs": 42 },
  "collectedAt": "2026-04-08T09:00:00.000Z",
  "metadata": {
    "failed": false,
    "httpStatus": 200
  }
}
```

**Via world state selectors in goals and actions:**

```yaml
# Selector for a nested field in the domain response
selector: "domains.my_service.data.latencyMs"
```

The full dot-path is `domains.<name>.data.<field>` for response body fields, or `domains.<name>.metadata.failed` for collection health.

## Per-project domains

If you have a project registered in `workspace/projects.yaml`, you can add a `domains.yaml` alongside its workspace:

```
workspace/
  projects.yaml         # references project config directories
  my-project/
    domains.yaml        # per-project domains loaded at startup
    goals.yaml          # per-project goals
    actions.yaml        # per-project actions
```

`projects.yaml` must declare the project's workspace path:

```yaml
projects:
  - slug: my-project
    workspace: workspace/my-project
```

WorldStateEngine discovers and merges all per-project domains at startup. Domain names must be globally unique — if two projects declare the same name, startup will log a warning and the last one wins.

## Verifying a new domain

After adding a domain definition and restarting, check:

```bash
# Should show the domain in the list
curl http://localhost:3000/api/world-state | jq 'keys'

# Check collection health
curl http://localhost:3000/api/world-state/my_service | jq '.metadata'
# {"failed": false, "httpStatus": 200}
```

If `metadata.failed` is `true`, check:
- The URL is reachable from the server
- ENV vars are set correctly
- The endpoint returns valid JSON (not HTML error pages)

## Related

- [Your first GOAP goal](../tutorials/first-goap-goal.md) — use a domain in a goal selector
- [Add goals and actions](./add-goals-and-actions.md) — reference for selectors and operators
- [Explanation: world engine](../explanation/world-engine.md) — design rationale
- [Workspace files reference](../reference/workspace-files.md)

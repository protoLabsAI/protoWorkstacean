---
title: External bus subscribers — WebSocket
---

# External bus subscribers

External processes can join the in-process event bus over a WebSocket. Useful for:
- Building observability tools that watch specific topics
- Letting a sidecar service (alerting, archival, projection) react to bus traffic without registering as a plugin
- Bridging to another node (the kernel of a future multi-node `BusBridgePlugin` — see `CLAUDE.md`)

## Endpoint

```
WS /api/bus/subscribe?topic=<pattern>[&apiKey=<key>]
```

- **`topic`** (required) — bus topic pattern. Supports the same wildcards as `bus.subscribe`:
  - `#` matches any continuation (multi-segment): `message.inbound.#`
  - `*` matches one segment: `agent.skill.*`
  - Literal: `agent.skill.request`
- **`apiKey`** (required when `WORKSTACEAN_API_KEY` is set) — pass either as the `X-API-Key` header or `?apiKey=` query param.

## Message format

Every matched message is delivered as a JSON frame:

```json
{
  "topic": "agent.skill.request",
  "correlationId": "8e9b6a1c-...",
  "timestamp": 1748137622143,
  "payload": { "skill": "chat", "content": "hello", "...": "..." }
}
```

## Publishing back

The WebSocket is **read-only**. To publish onto the bus from outside, use `POST /publish` (same API key auth).

## Example — Node

```ts
import WebSocket from "ws";

const ws = new WebSocket(
  "ws://workstacean:3000/api/bus/subscribe?topic=agent.skill.request",
  { headers: { "X-API-Key": process.env.WORKSTACEAN_API_KEY } },
);

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  console.log(`[${msg.topic}]`, msg.payload);
});
```

## Example — curl + websocat

```bash
websocat -H "X-API-Key: $WORKSTACEAN_API_KEY" \
  "ws://workstacean:3000/api/bus/subscribe?topic=message.inbound.%23"
```

## When to use this vs a plugin

Use a **plugin** when the consumer lives in the same process and needs deep access to the event bus, agent registry, or shared services.

Use the **WebSocket** when the consumer is a separate process (different runtime, different machine, different deploy lifecycle) that only needs to **observe** topic traffic. The bus contract — typed payloads, hierarchical topics, correlationId trace propagation — works identically.

## Related

- [`GET /api/bus/topology`](../reference/http-api.md) — see what plugins publish and subscribe to which topics, useful for picking what to subscribe to.
- `POST /publish` — publish a single bus message (HTTP, authenticated).
- `CLAUDE.md` — bus topic naming convention and multi-node decision.

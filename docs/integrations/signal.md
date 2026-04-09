---
title: Signal
---

Bridges Signal to the Workstacean bus via a WebSocket connection to a [signal-cli REST API](https://github.com/bbernhard/signal-cli-rest-api) instance. Inbound messages become bus events; outbound bus messages are sent as Signal messages.

The plugin is **disabled entirely** if `SIGNAL_URL` or `SIGNAL_NUMBER` are not set.

## Setup

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SIGNAL_URL` | Yes | Base URL of the signal-cli REST API (e.g. `https://user:pass@signal.example.com`) |
| `SIGNAL_NUMBER` | Yes | Phone number registered with Signal (e.g. `+15551234567`) |

Credentials can be embedded in the URL using `https://user:pass@host` format. If present, the plugin strips them from the URL and sends them as an `Authorization: Basic` header.

## Bus Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `message.inbound.signal.{sender}` | Inbound | Message received from a Signal user |
| `message.outbound.signal.{recipient}` | Outbound | Send a Signal message to a recipient |

## Inbound Payload

```typescript
{
  sender: string;    // Signal phone number of the sender
  content: string;   // Message text
  channel: string;   // Same as sender — used as reply target
}
```

## Outbound Payload

```typescript
{
  content: string;   // Message text to send
}
```

The plugin resolves the recipient from the outbound topic (`message.outbound.signal.{recipient}`) or from `payload.channel` on a reply.

## Cron Integration

Cron payloads that set `channel: "signal"` are delivered via Signal:

```yaml
# workspace/crons/daily-weather.yaml
topic: cron.daily-weather
payload:
  content: "Tell the user today's weather for their location."
  sender: "cron"
  channel: "signal"
```

RouterPlugin routes the cron event to the agent, and the agent's reply is published to `message.outbound.signal.{sender}`, which SignalPlugin delivers.
